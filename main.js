"use strict";

const {
  ItemView,
  MarkdownView,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  normalizePath,
  requestUrl,
  setIcon
} = require("obsidian");

const VIEW_TYPE = "research-agent-view";
const LEGACY_RESEARCH_DATA = ".obsidian/plugins/research-report/data.json";
const HISTORY_LIMIT = 80;
const SHOW_PROMPT_SHORTCUTS = false;

const DEFAULT_SETTINGS = {
  controlPlaneBaseUrl: "https://research.obclaude.com",
  controlPlaneEmail: "",
  controlPlaneInviteCode: "",
  controlPlaneRefreshToken: "",
  controlPlaneDeviceId: "",
  controlPlaneClientVersion: "0.3.0",
  outputFolder: "行业研究",
  maxDocumentContextChars: 12000,
  launchInRightSidebar: true
};

module.exports = class ResearchAgentPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.accessToken = "";
    this.bootstrap = null;
    this.bootstrapError = "";
    this.controlPlanePasswordCache = "";
    this.refreshTokenPromise = null;
    this.lastSelectionContext = { text: "", filePath: "", capturedAt: 0 };

    this.registerView(VIEW_TYPE, (leaf) => new ResearchAgentView(leaf, this));

    this.addRibbonIcon("sparkles", "Open Research Agent", async () => {
      await this.activateView();
    });

    this.addCommand({
      id: "open-research-agent",
      name: "Open Research Agent",
      callback: async () => {
        await this.activateView();
      }
    });

    this.addCommand({
      id: "research-active-note-with-agent",
      name: "Research Active Note With Agent",
      editorCallback: async () => {
        const view = await this.activateView();
        if (view && typeof view.prefillActiveNoteResearch === "function") {
          await view.prefillActiveNoteResearch();
        }
      }
    });

    this.addCommand({
      id: "research-agent-follow-up-from-selection",
      name: "基于划线内容追问 / 继续研究",
      editorCheckCallback: (checking, editor, view) => {
        const selectionText = this.readCurrentSelectionText(editor);
        if (checking) {
          return Boolean(selectionText);
        }
        if (!selectionText) {
          new Notice("请先在文档中选择一段文本。");
          return false;
        }
        this.handleSelectionFollowUp(selectionText, view).catch((error) => {
          new Notice(error instanceof Error ? error.message : "无法基于划线内容继续研究。", 6000);
        });
        return true;
      }
    });

    this.addCommand({
      id: "research-agent-follow-up-from-current-selection",
      name: "基于当前划线内容追问",
      callback: async () => {
        const selectionText = this.readCurrentSelectionText();
        if (!selectionText) {
          new Notice("请先在文档中选择一段文本。");
          return;
        }
        try {
          await this.handleSelectionFollowUp(selectionText);
        } catch (error) {
          new Notice(error instanceof Error ? error.message : "无法基于划线内容继续研究。", 6000);
        }
      }
    });

    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor, view) => {
        const selection = this.readCurrentSelectionText(editor);
        if (!selection) return;
        menu.addItem((item) => {
          item
            .setTitle("Research Agent：基于划线内容追问")
            .setIcon("sparkles")
            .onClick(async () => {
              try {
                await this.handleSelectionFollowUp(selection, view);
              } catch (error) {
                new Notice(error instanceof Error ? error.message : "无法基于划线内容继续研究。", 6000);
              }
            });
        });
      })
    );
    this.registerDomEvent(document, "selectionchange", () => {
      const text = this.readCurrentSelectionText(null, false);
      if (!text) return;
      const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (!activeView?.file) return;
      this.lastSelectionContext = {
        text,
        filePath: activeView.file.path,
        capturedAt: Date.now()
      };
    });

    this.registerResearchAgentBridge();
    this.addSettingTab(new ResearchAgentSettingTab(this.app, this));
    this.refreshBootstrap().catch(() => {});
  }

  async onunload() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE);
  }

  async activateView() {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    const leaf = existing || (this.settings.launchInRightSidebar
      ? this.app.workspace.getRightLeaf(false)
      : this.app.workspace.getLeaf(true));

    await leaf.setViewState({ type: VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);
    return leaf.view;
  }

  registerResearchAgentBridge() {
    window.__researchAgentBridge = {
      openWithHandoff: async (payload) => {
        const view = await this.activateView();
        if (view && typeof view.prefillMultiAgentHandoff === "function") {
          view.prefillMultiAgentHandoff(payload || {});
        }
      }
    };

    this.register(() => {
      if (window.__researchAgentBridge?.openWithHandoff) {
        delete window.__researchAgentBridge;
      }
    });

    this.registerDomEvent(window, "research-agent-handoff", async (event) => {
      const view = await this.activateView();
      if (view && typeof view.prefillMultiAgentHandoff === "function") {
        view.prefillMultiAgentHandoff(event.detail || {});
      }
    });
  }

  async loadSettings() {
    const stored = await this.loadData();
    const { historyRecords, ...storedSettings } = stored || {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, storedSettings || {});
    this.historyRecords = Array.isArray(historyRecords) ? historyRecords : [];

    if (!stored || (!stored.controlPlaneRefreshToken && !stored.controlPlaneEmail)) {
      await this.importLegacyResearchSettings();
    }
  }

  async saveSettings() {
    const { historyRecords, controlPlanePassword, ...settings } = this.settings || {};
    await this.saveData({
      ...settings,
      historyRecords: this.historyRecords || []
    });
  }

  getHistoryRecords() {
    return Array.isArray(this.historyRecords) ? this.historyRecords : [];
  }

  async upsertHistoryRecord(task, context = {}, extra = {}) {
    if (!task) return null;
    const record = buildHistoryRecord(task, context, extra);
    if (!record.id) return null;
    const records = this.getHistoryRecords().filter((item) => item.id !== record.id);
    const previous = this.getHistoryRecords().find((item) => item.id === record.id) || {};
    const next = {
      ...previous,
      ...record,
      ...extra,
      createdAt: previous.createdAt || record.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    this.historyRecords = [next, ...records]
      .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))
      .slice(0, HISTORY_LIMIT);
    await this.saveSettings();
    return next;
  }

  async importLegacyResearchSettings() {
    try {
      const raw = await this.app.vault.adapter.read(LEGACY_RESEARCH_DATA);
      const legacy = JSON.parse(raw);
      this.settings.controlPlaneBaseUrl =
        legacy.controlPlaneBaseUrl || this.settings.controlPlaneBaseUrl;
      this.settings.controlPlaneEmail = legacy.controlPlaneEmail || this.settings.controlPlaneEmail;
      this.settings.controlPlaneRefreshToken =
        legacy.controlPlaneRefreshToken || this.settings.controlPlaneRefreshToken;
      this.settings.controlPlaneDeviceId =
        legacy.controlPlaneDeviceId || this.settings.controlPlaneDeviceId;
      this.settings.outputFolder = legacy.defaultReportFolder || this.settings.outputFolder;
      this.settings.maxDocumentContextChars =
        legacy.maxDocumentContextChars || this.settings.maxDocumentContextChars;
      await this.saveSettings();
    } catch {}
  }

  getBaseUrl() {
    return normalizeCloudBaseUrl(this.settings.controlPlaneBaseUrl);
  }

  setControlPlanePassword(password) {
    this.controlPlanePasswordCache = password || "";
  }

  getControlPlanePassword() {
    return this.controlPlanePasswordCache || "";
  }

  isAuthSetupError(error) {
    const message = error instanceof Error ? error.message : String(error || "");
    return message.includes("Research Agent 还没有登录")
      || message.includes("请填写云端服务地址、账号邮箱和密码")
      || message.includes("登录会话已过期");
  }

  openPluginSettings() {
    const setting = this.app.setting;
    setting?.open?.();
    setting?.openTabById?.(this.manifest.id);
  }

  readCurrentSelectionText(editor = null, includeLastSelection = true) {
    const fromEditor = String(editor?.getSelection?.() || "").trim();
    if (fromEditor) return fromEditor;
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    const fromActiveEditor = String(activeView?.editor?.getSelection?.() || "").trim();
    if (fromActiveEditor) return fromActiveEditor;
    const fromWindow = String(window.getSelection?.().toString?.() || "").trim();
    if (fromWindow) return fromWindow;
    if (includeLastSelection && this.lastSelectionContext?.text) {
      return this.lastSelectionContext.text;
    }
    return "";
  }

  getAuthHeaders(withDevice = true) {
    const headers = {
      Authorization: `Bearer ${this.accessToken}`,
      "x-client-version": this.settings.controlPlaneClientVersion || "0.3.0"
    };
    if (withDevice && this.settings.controlPlaneDeviceId) {
      headers["x-device-id"] = this.settings.controlPlaneDeviceId;
    }
    return headers;
  }

  async request(path, options = {}) {
    const url = `${this.getBaseUrl()}${path}`;
    const response = await requestUrl({
      url,
      method: options.method || "GET",
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {})
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      throw: false,
      timeout: options.timeout || 45000
    });

    const data = parseJson(response.text);
    if (response.status < 200 || response.status >= 300) {
      const message = data?.error?.message || data?.message || `请求失败：${response.status}`;
      const error = new Error(message);
      error.status = response.status;
      error.code = data?.error?.code || data?.code || "REQUEST_FAILED";
      error.data = data;
      throw error;
    }
    return data;
  }

  async refreshAccessToken() {
    if (this.refreshTokenPromise) {
      return this.refreshTokenPromise;
    }
    this.refreshTokenPromise = this._performTokenRefresh().finally(() => {
      this.refreshTokenPromise = null;
    });
    return this.refreshTokenPromise;
  }

  async _performTokenRefresh() {
    const refreshToken = String(this.settings.controlPlaneRefreshToken || "").trim();
    if (!refreshToken) {
      throw new Error("Research Agent 还没有登录 Deep Research Cloud。请在 Research Agent 设置中填写服务地址、账号邮箱和密码，然后点击“登录 Deep Research Cloud”。");
    }

    let data;
    try {
      data = await this.request("/api/v1/auth/refresh", {
        method: "POST",
        body: { refreshToken },
        timeout: 30000
      });
    } catch (error) {
      if (error?.status === 401) {
        this.accessToken = "";
        this.settings.controlPlaneRefreshToken = "";
        this.settings.controlPlaneDeviceId = "";
        await this.saveSettings();
        const reason = error?.code === "REFRESH_TOKEN_EXPIRED"
          ? "登录会话已过期，请重新登录 Deep Research Cloud。"
          : "登录会话失效，请重新登录 Deep Research Cloud。";
        throw new Error(reason);
      }
      throw error;
    }
    this.accessToken = data.accessToken || "";
    this.settings.controlPlaneRefreshToken = data.refreshToken || refreshToken;
    if (data.session?.deviceId) {
      this.settings.controlPlaneDeviceId = data.session.deviceId;
    }
    await this.saveSettings();
  }

  async authedRequest(path, options = {}) {
    if (!this.accessToken) {
      await this.refreshAccessToken();
    }
    const buildHeaders = () => ({
      ...this.getAuthHeaders(options.includeDeviceHeader !== false),
      ...(options.headers || {})
    });
    try {
      return await this.request(path, { ...options, headers: buildHeaders() });
    } catch (error) {
      if (error?.status === 401 && error?.code === "ACCESS_TOKEN_EXPIRED") {
        await this.refreshAccessToken();
        return this.request(path, { ...options, headers: buildHeaders() });
      }
      throw error;
    }
  }

  async loginCloudAccount(password = this.getControlPlanePassword()) {
    const email = String(this.settings.controlPlaneEmail || "").trim();
    const secret = String(password || "").trim();
    this.settings.controlPlaneBaseUrl = this.getBaseUrl();
    if (!email || !secret) {
      throw new Error("请填写云端服务地址、账号邮箱和密码。");
    }

    const data = await this.request("/api/v1/auth/login", {
      method: "POST",
      body: { email, password: secret },
      timeout: 30000
    });
    this.accessToken = data.accessToken || "";
    this.settings.controlPlaneRefreshToken = data.refreshToken || "";
    this.settings.controlPlaneDeviceId = data.session?.deviceId || "";
    this.setControlPlanePassword(secret);
    if (!this.accessToken || !this.settings.controlPlaneRefreshToken) {
      throw new Error("登录成功但没有收到完整会话，请重试。");
    }
    await this.saveSettings();
    await this.ensureDevice();
    return await this.refreshBootstrap();
  }

  async registerCloudAccount(password = this.getControlPlanePassword()) {
    const email = String(this.settings.controlPlaneEmail || "").trim();
    const secret = String(password || "").trim();
    const inviteCode = String(this.settings.controlPlaneInviteCode || "").trim();
    this.settings.controlPlaneBaseUrl = this.getBaseUrl();
    if (!email || !secret || !inviteCode) {
      throw new Error("注册需要填写云端服务地址、账号邮箱、密码和邀请码。");
    }

    await this.request("/api/v1/auth/register", {
      method: "POST",
      body: { email, password: secret, inviteCode },
      timeout: 30000
    });
    return await this.loginCloudAccount(secret);
  }

  async clearCloudSession() {
    this.accessToken = "";
    this.bootstrap = null;
    this.bootstrapError = "";
    this.settings.controlPlaneRefreshToken = "";
    this.settings.controlPlaneDeviceId = "";
    this.setControlPlanePassword("");
    await this.saveSettings();
  }

  async ensureDevice() {
    if (this.settings.controlPlaneDeviceId) return;
    const data = await this.authedRequest("/api/v1/devices/register", {
      method: "POST",
      includeDeviceHeader: false,
      body: {
        name: this.manifest.name,
        platform: "macos",
        clientVersion: this.settings.controlPlaneClientVersion || "0.3.0"
      },
      timeout: 30000
    });
    this.settings.controlPlaneDeviceId = data.device?.deviceId || "";
    await this.saveSettings();
  }

  async ensureAuthenticated() {
    if (!this.accessToken) {
      await this.refreshAccessToken();
    }
    await this.ensureDevice();
  }

  async refreshBootstrap() {
    try {
      await this.ensureAuthenticated();
      this.bootstrap = await this.authedRequest("/api/v1/bootstrap", {
        timeout: 30000
      });
      this.bootstrapError = "";
      return this.bootstrap;
    } catch (error) {
      this.bootstrap = null;
      this.bootstrapError = error instanceof Error ? error.message : "连接云端失败。";
      throw error;
    }
  }

  async invokeAgentAssist(context, conversation) {
    await this.ensureAuthenticated();
    const data = await this.authedRequest("/api/v1/capabilities/research.agent_assist/invoke", {
      method: "POST",
      body: { context, conversation },
      timeout: 45000
    });
    return data.result;
  }

  async invokeFactGuard(context) {
    await this.ensureAuthenticated();
    const data = await this.authedRequest("/api/v1/capabilities/research.fact_guard/invoke", {
      method: "POST",
      body: { context },
      timeout: 45000
    });
    return data.result;
  }

  async createResearchTask(context) {
    await this.ensureAuthenticated();
    const data = await this.authedRequest("/api/v1/tasks", {
      method: "POST",
      body: { capabilityKey: "research.deep_research", context },
      timeout: 60000
    });
    return data.task;
  }

  async confirmResearchTask(taskId) {
    await this.ensureAuthenticated();
    const data = await this.authedRequest(`/api/v1/tasks/${encodeURIComponent(taskId)}/confirm`, {
      method: "POST",
      body: {},
      timeout: 45000
    });
    return data.task;
  }

  async getResearchTask(taskId) {
    await this.ensureAuthenticated();
    const data = await this.authedRequest(`/api/v1/tasks/${encodeURIComponent(taskId)}`, {
      timeout: 30000
    });
    return data.task;
  }

  async exportTaskMarkdown(taskId, task = null, options = {}) {
    await this.ensureAuthenticated();
    const data = await this.authedRequest(`/api/v1/tasks/${encodeURIComponent(taskId)}/export-markdown`, {
      method: "POST",
      body: {},
      timeout: 60000
    });
    const folderPath = normalizePath(this.settings.outputFolder || DEFAULT_SETTINGS.outputFolder);
    await ensureFolder(this.app, folderPath);
    const fileName = ensureMarkdownFileName(data.fileName || "research-agent-report.md");
    const filePath = await uniqueVaultPath(this.app, normalizePath(`${folderPath}/${fileName}`));
    const markdown = buildResearchNoteMarkdown({
      task,
      cloudMarkdown: data.markdown || "",
      exportedAt: new Date().toISOString(),
      followUpOfTaskId: options.followUpOfTaskId || "",
      sourceTitle: options.sourceTitle || "",
      sourcePath: options.sourcePath || ""
    });
    await this.app.vault.create(filePath, markdown);
    return filePath;
  }

  async openVaultFile(file) {
    if (!file) return;
    const leaf = this.app.workspace.getLeaf(false);
    try {
      await leaf.openFile(file);
    } catch (error) {
      this.app.workspace.openLinkText(file.path, "", false);
    }
  }

  findHistoryRecordByExportedPath(path) {
    if (!path) return null;
    const normalized = normalizePath(path);
    return this.getHistoryRecords().find((item) => {
      if (!item?.exportedPath) return false;
      try {
        return normalizePath(item.exportedPath) === normalized;
      } catch {
        return item.exportedPath === path;
      }
    }) || null;
  }

  getActiveMarkdownContext() {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView)
      || this.app.workspace.getLeavesOfType("markdown")
        .map((leaf) => leaf.view)
        .find((candidate) => candidate instanceof MarkdownView && candidate.file);
    const file = view?.file || null;
    const selectedText = this.readCurrentSelectionText(view?.editor);
    return {
      file,
      selectedText,
      contentPromise: file ? this.app.vault.cachedRead(file) : Promise.resolve("")
    };
  }

  async buildResearchContext(userQuery, options = {}) {
    const includeCurrentContext = options.includeCurrentContext === true;
    const { file, selectedText, contentPromise } = this.getActiveMarkdownContext();
    const content = includeCurrentContext ? await contentPromise : "";
    const max = Math.max(Number(this.settings.maxDocumentContextChars) || 12000, 2000);

    const selectionOverride = options.selection ? String(options.selection).slice(0, max) : "";
    const selectionFromEditor = includeCurrentContext && selectedText ? selectedText.slice(0, max) : "";
    const selection = selectionOverride || selectionFromEditor || undefined;

    const documentTitle = options.documentTitle
      || (includeCurrentContext ? file?.basename : undefined)
      || (selectionOverride ? options.documentTitle : undefined);
    const documentPath = options.documentPath
      || (includeCurrentContext ? file?.path : undefined);
    const excerpt = includeCurrentContext && content
      ? content.slice(0, max)
      : (options.documentExcerpt ? String(options.documentExcerpt).slice(0, max) : undefined);

    return {
      userQuery,
      selection,
      documentTitle: documentTitle || undefined,
      documentPath: documentPath || undefined,
      documentExcerpt: excerpt,
      researchDepth: options.researchDepth || "standard",
      timeRange: options.timeRange || "auto",
      sourceLanguage: options.sourceLanguage || "auto",
      outputFormat: options.outputFormat || "structured_report",
      includeCurrentContext,
      followUpOfTaskId: options.followUpOfTaskId || undefined,
      sourceReportPath: options.sourceReportPath || undefined,
      sourceTitle: options.sourceTitle || undefined
    };
  }

  async handleSelectionFollowUp(selectionText, sourceView) {
    const trimmed = String(selectionText || "").trim();
    if (!trimmed) {
      new Notice("请先在文档中选择一段文本。");
      return;
    }
    const lastSelectionFile = this.lastSelectionContext?.filePath
      ? this.app.vault.getAbstractFileByPath(this.lastSelectionContext.filePath)
      : null;
    const file = sourceView?.file
      || this.app.workspace.getActiveViewOfType(MarkdownView)?.file
      || lastSelectionFile
      || null;
    const linkedRecord = file ? this.findHistoryRecordByExportedPath(file.path) : null;
    const max = Math.max(Number(this.settings.maxDocumentContextChars) || 12000, 2000);
    const payload = {
      selection: trimmed.slice(0, max),
      sourceTitle: file?.basename || "",
      sourcePath: file?.path || "",
      followUpOfTaskId: linkedRecord?.taskId || linkedRecord?.id || "",
      sourceReportPath: linkedRecord?.exportedPath || (file?.path || "")
    };
    const view = await this.activateView();
    if (view && typeof view.beginSelectionFollowUp === "function") {
      view.beginSelectionFollowUp(payload);
    }
  }
};

class ResearchAgentView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.messages = [];
    this.currentTask = null;
    this.currentContext = null;
    this.pollTimer = null;
    this.includeActiveNoteContextOnce = false;
    this.pendingPlanRevision = null;
    this.runtimeNarration = {
      lastSignal: "",
      lastMilestone: -1,
      riskSignature: "",
      completedTaskIds: new Set()
    };
    this.autoExportInFlight = new Set();
    this.pendingFollowUpSelection = null;
    this.confirmingTaskIds = new Set();
    this.confirmedTaskIds = new Set();
    this.messageDedupeKeys = new Set();
    this.lastAgentAssistResult = null;
  }

  getViewType() {
    return VIEW_TYPE;
  }

  getDisplayText() {
    return "Research Agent";
  }

  getIcon() {
    return "sparkles";
  }

  async onOpen() {
    this.render();
  }

  async onClose() {
    this.stopPolling();
  }

  async prefillActiveNoteResearch() {
    const { file } = this.plugin.getActiveMarkdownContext();
    this.pendingPlanRevision = null;
    this.includeActiveNoteContextOnce = true;
    this.inputEl.value = file
      ? `围绕当前笔记《${file.basename}》继续研究，先判断还缺哪些证据，再给我一个可执行结论。`
      : "帮我研究当前问题，先确认研究边界，再给出证据和行动建议。";
    this.inputEl.focus();
  }

  prefillMultiAgentHandoff(payload = {}) {
    this.pendingPlanRevision = null;
    this.includeActiveNoteContextOnce = false;
    this.inputEl.value = buildMultiAgentHandoffPrompt(payload);
    this.inputEl.focus();
    this.appendMessage("agent", "我已接到这条研究接力。你可以直接补充想要的结论口径、范围或输出形式。", {
      name: "Research Agent",
      actions: [
        {
          label: "开始判断",
          cta: true,
          onClick: () => this.handleUserSubmit()
        }
      ]
    });
  }

  beginSelectionFollowUp(payload = {}) {
    const selection = String(payload.selection || "").trim();
    if (!selection) {
      new Notice("没有读取到划线内容。");
      return;
    }
    this.pendingPlanRevision = null;
    this.includeActiveNoteContextOnce = false;
    this.pendingFollowUpSelection = {
      selection,
      sourceTitle: String(payload.sourceTitle || "").trim(),
      sourcePath: String(payload.sourcePath || "").trim(),
      followUpOfTaskId: String(payload.followUpOfTaskId || "").trim(),
      sourceReportPath: String(payload.sourceReportPath || "").trim(),
      createdAt: new Date().toISOString()
    };
    const preview = compactText(selection, 220);
    const sourceLabel = this.pendingFollowUpSelection.sourceTitle
      ? `《${this.pendingFollowUpSelection.sourceTitle}》`
      : (this.pendingFollowUpSelection.sourcePath || "当前文档");
    const linkedTip = this.pendingFollowUpSelection.followUpOfTaskId
      ? `（已关联到历史研究 ${this.pendingFollowUpSelection.followUpOfTaskId.slice(0, 8)}…）`
      : "";
    const seedQuestion = this.inputEl.value.trim()
      ? this.inputEl.value
      : `针对 ${sourceLabel} 中划线的这段内容，请帮我继续研究：`;
    this.inputEl.value = seedQuestion;
    this.inputEl.focus();
    this.appendMessage(
      "agent",
      [
        `已接到来自 ${sourceLabel} 的划线内容${linkedTip}：`,
        `> ${preview}`,
        "",
        "请告诉我你希望围绕这段内容得到什么结论；也可以直接指定输出形式。"
      ].join("\n"),
      {
        actions: [
          {
            label: "生成研究计划",
            cta: true,
            onClick: () => this.runSelectionDeepResearch()
          },
          {
            label: "取消",
            onClick: () => {
              this.pendingFollowUpSelection = null;
              this.appendMessage("agent", "已取消基于划线内容的追问。");
            }
          }
        ]
      }
    );
  }

  consumePendingFollowUpSelection() {
    const pending = this.pendingFollowUpSelection;
    this.pendingFollowUpSelection = null;
    return pending;
  }

  async runSelectionAgentAssist() {
    const pending = this.consumePendingFollowUpSelection();
    if (!pending) {
      new Notice("没有待处理的划线内容。");
      return;
    }
    const queryRaw = String(this.inputEl.value || "").trim();
    const query = queryRaw || `请基于这段划线内容给我一段判断：${compactText(pending.selection, 120)}`;
    this.inputEl.value = "";
    this.appendMessage("user", query);
    this.setActiveStage("understanding");
    this.renderLoadingEvidence("Agent 正在判断划线内容应该如何回答...");
    try {
      const context = await this.plugin.buildResearchContext(query, {
        selection: pending.selection,
        documentTitle: pending.sourceTitle,
        documentPath: pending.sourcePath,
        documentExcerpt: pending.selection,
        followUpOfTaskId: pending.followUpOfTaskId,
        sourceReportPath: pending.sourceReportPath,
        sourceTitle: pending.sourceTitle
      });
      this.currentContext = context;
      const result = await this.plugin.invokeAgentAssist(context, this.messages.slice(-8));
      this.setActiveStage("decision");
      this.lastAgentAssistResult = result;
      if (shouldCreateResearchPlan(result)) {
        this.renderAssistEvidence(result);
        await this.createResearchPlan();
      } else {
        this.renderAgentAssistResult(result);
      }
    } catch (error) {
      this.setActiveStage("idle");
      this.renderError(error);
      this.appendMessage(
        "agent",
        error instanceof Error ? error.message : "Agent 判断失败。",
        this.authErrorActions(error)
      );
    }
  }

  async runSelectionDeepResearch() {
    const pending = this.consumePendingFollowUpSelection();
    if (!pending) {
      new Notice("没有待处理的划线内容。");
      return;
    }
    const queryRaw = String(this.inputEl.value || "").trim();
    const baseQuery = queryRaw || `请围绕这段划线内容继续做深度研究：${compactText(pending.selection, 120)}`;
    this.inputEl.value = "";
    this.appendMessage("user", baseQuery);
    const enrichedQuery = buildSelectionFollowUpQuery(baseQuery, pending);
    this.setActiveStage("decision");
    this.renderLoadingEvidence("正在为划线内容生成 Deep Research 路径...");
    try {
      const context = await this.plugin.buildResearchContext(enrichedQuery, {
        selection: pending.selection,
        documentTitle: pending.sourceTitle,
        documentPath: pending.sourcePath,
        documentExcerpt: pending.selection,
        followUpOfTaskId: pending.followUpOfTaskId,
        sourceReportPath: pending.sourceReportPath,
        sourceTitle: pending.sourceTitle
      });
      this.currentContext = context;
      const task = await this.plugin.createResearchTask(context);
      this.currentTask = task;
      const path = buildAgentResearchPath(task.plan, context);
      await this.rememberTask(task, {
        pathPreview: path.objective,
        followUpOfTaskId: pending.followUpOfTaskId || "",
        sourceReportPath: pending.sourceReportPath || pending.sourcePath || ""
      });
      this.appendResearchPlanMessage(path, {
        prefix: "已基于划线内容生成 Deep Research 路径。请确认是否继续："
      });
      this.renderTaskEvidence(task, path);
    } catch (error) {
      this.renderError(error);
      this.appendMessage(
        "agent",
        error instanceof Error ? error.message : "Deep Research 路径生成失败。",
        this.authErrorActions(error)
      );
    }
  }

  render() {
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass("research-agent-view");

    const shell = container.createDiv({ cls: "ra-shell" });
    const mainColumn = shell.createDiv({ cls: "ra-main-column" });
    const sideColumn = shell.createDiv({ cls: "ra-side-column" });
    this.renderChat(mainColumn.createDiv({ cls: "ra-chat-panel" }));
    this.historyEl = sideColumn.createDiv({ cls: "ra-history-panel" });
    this.renderHistoryList();
    this.renderEvidence(sideColumn.createDiv({ cls: "ra-evidence-panel" }));
    this.renderWelcome();
  }

  renderChat(panel) {
    const header = panel.createDiv({ cls: "ra-panel-header" });
    const title = header.createDiv();
    title.createEl("h2", { text: "Research Agent" });
    title.createEl("p", { text: "直接说研究目标；需要当前笔记时再点“使用当前笔记”。" });

    this.flowEl = panel.createDiv({ cls: "ra-flow-panel ra-flow-strip is-hidden" });
    this.renderFlow(this.flowEl);
    this.chatEl = panel.createDiv({ cls: "ra-chat-stream" });

    const composer = panel.createDiv({ cls: "ra-composer" });
    this.inputEl = composer.createEl("textarea", {
      cls: "ra-input",
      placeholder: "例如：帮我判断短剧复仇爽点还值不值得做，偏编剧团队决策。"
    });

    if (SHOW_PROMPT_SHORTCUTS) {
      const shortcuts = composer.createDiv({ cls: "ra-shortcuts" });
      [
        ["帮我研究一个选题", "我想研究一个选题，请先帮我收窄问题并判断需要哪些证据。"],
        ["核查这个说法", "请把我接下来这句话当作待核查断言，先判断风险，再建议是否运行 Fact Guard。"],
        ["补充证据", "请基于当前笔记，判断还缺哪些证据，并建议下一步研究路径。"],
        ["参与多 Agent 讨论", "请作为研究 Agent 参与当前多 Agent 讨论，判断哪些问题需要研究、核查或补充证据。"]
      ].forEach(([label, prompt]) => {
        const button = shortcuts.createEl("button", { text: label });
        button.addEventListener("click", () => {
          this.pendingPlanRevision = null;
          this.inputEl.value = prompt;
          this.inputEl.focus();
        });
      });
    }

    const actionRow = composer.createDiv({ cls: "ra-composer-actions" });
    const useNoteButton = actionRow.createEl("button", { text: "使用当前笔记" });
    useNoteButton.addEventListener("click", () => this.prefillActiveNoteResearch());
    const useSelectionButton = actionRow.createEl("button", { text: "基于当前划线追问" });
    useSelectionButton.addEventListener("click", async () => {
      const selectionText = this.plugin.readCurrentSelectionText();
      if (!selectionText) {
        new Notice("请先在文档中选择一段文本。");
        return;
      }
      try {
        await this.plugin.handleSelectionFollowUp(selectionText);
      } catch (error) {
        new Notice(error instanceof Error ? error.message : "无法基于划线内容继续研究。", 6000);
      }
    });
    const sendButton = actionRow.createEl("button", { cls: "mod-cta", text: "发送给 Agent" });
    sendButton.addEventListener("click", () => this.handleUserSubmit());
    this.inputEl.addEventListener("keydown", (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        this.handleUserSubmit();
      }
    });
  }

  renderFlow(panel) {
    const header = panel.createDiv({ cls: "ra-panel-header" });
    header.createEl("h3", { text: "任务流" });
    header.createEl("p", { text: "研究不是黑盒：每一步都能停下、确认或继续。" });
    this.stageEl = panel.createDiv({ cls: "ra-stage-list" });
    this.setStages([
      ["understanding", "理解问题", "识别意图、硬断言和研究范围。"],
      ["decision", "确认方向", "需要时先追问或建议升级研究。"],
      ["researching", "收集证据", "运行 Deep Research 长任务。"],
      ["checking", "自检补强", "标出风险、缺口和待核查项。"],
      ["delivery", "交付结果", "生成笔记或继续追问。"]
    ], "idle");
  }

  renderEvidence(panel) {
    const header = panel.createDiv({ cls: "ra-panel-header" });
    header.createEl("h3", { text: "证据与结果" });
    header.createEl("p", { text: "来源、风险和交付物单独放在这里，避免淹没对话。" });
    this.evidenceEl = panel.createDiv({ cls: "ra-evidence-body" });
    this.renderEmptyEvidence();
  }

  renderWelcome() {
    this.chatEl.empty();
    this.appendMessage("agent", "你想了解什么？直接输入问题即可。需要参考当前笔记时，点击“使用当前笔记”。");
  }

  appendMessage(role, text, options = {}) {
    if (options.dedupeKey) {
      if (this.messageDedupeKeys.has(options.dedupeKey)) return;
      this.messageDedupeKeys.add(options.dedupeKey);
    }
    const item = this.chatEl.createDiv({ cls: `ra-message ra-message-${role}` });
    const meta = item.createDiv({ cls: "ra-message-meta" });
    meta.setText(role === "user" ? "你" : options.name || "Research Agent");
    item.createDiv({ cls: "ra-message-body", text });
    if (options.actions?.length) {
      const actions = item.createDiv({ cls: "ra-message-actions" });
      options.actions.forEach((action) => {
        const button = actions.createEl("button", { text: action.label });
        if (action.cta) button.addClass("mod-cta");
        button.addEventListener("click", action.onClick);
      });
    }
    this.chatEl.scrollTop = this.chatEl.scrollHeight;
    this.messages.push({ role: role === "user" ? "user" : "assistant", content: text });
  }

  async handleUserSubmit() {
    const query = String(this.inputEl.value || "").trim();
    if (!query) {
      new Notice("先输入你想研究的问题。");
      return;
    }
    this.inputEl.value = "";
    this.appendMessage("user", query);
    if (this.pendingPlanRevision) {
      await this.reviseResearchPlan(query);
      return;
    }
    const includeCurrentContext = this.includeActiveNoteContextOnce;
    this.includeActiveNoteContextOnce = false;
    await this.runAgentAssist(query, { includeCurrentContext });
  }

  async runAgentAssist(query, options = {}) {
    this.setActiveStage("understanding");
    this.renderLoadingEvidence("正在整理答案...");
    try {
      const context = await this.plugin.buildResearchContext(query, {
        includeCurrentContext: options.includeCurrentContext === true
      });
      this.currentContext = context;
      const result = await this.plugin.invokeAgentAssist(context, this.messages.slice(-8));
      this.setActiveStage(result.route === "ask_clarification" ? "decision" : "decision");
      this.lastAgentAssistResult = result;
      if (shouldCreateResearchPlan(result)) {
        this.renderAssistEvidence(result);
        await this.createResearchPlan();
      } else {
        this.renderAgentAssistResult(result);
      }
    } catch (error) {
      this.setActiveStage("idle");
      this.renderError(error);
      this.appendMessage("agent", error instanceof Error ? error.message : "Agent 判断失败。", this.authErrorActions(error));
    }
  }

  authErrorActions(error) {
    if (!this.plugin.isAuthSetupError(error)) return {};
    return {
      actions: [
        {
          label: "打开登录设置",
          cta: true,
          onClick: () => this.plugin.openPluginSettings()
        },
        {
          label: "导入旧登录状态",
          onClick: async () => {
            await this.plugin.importLegacyResearchSettings();
            new Notice("已尝试导入旧 Deep Research 登录状态。");
            this.plugin.openPluginSettings();
          }
        }
      ]
    };
  }

  renderAgentAssistResult(result) {
    const keyPoints = (result.answer?.keyPoints || []).slice(0, 4);
    const summary = [
      result.answer?.summary || "我已经完成初步判断。",
      ...keyPoints.map((item) => `- ${item}`)
    ].join("\n");
    const actions = [];

    if (result.route === "ask_clarification") {
      normalizeList(result.suggestedQuestions).slice(0, 3).forEach((question) => {
        actions.push({
          label: compactText(question, 32),
          onClick: () => {
            this.inputEl.value = question;
            this.inputEl.focus();
          }
        });
      });
      actions.push({
        label: "生成研究计划",
        cta: true,
        onClick: () => this.createResearchPlan()
      });
      this.appendMessage("agent", "我需要先确认一下你的重点。", { actions });
      this.renderAssistEvidence(result);
      return;
    }

    if (result.route === "run_fact_guard" || result.recommendedNextCapability === "research.fact_guard") {
      actions.push({
        label: "先核查断言",
        cta: true,
        onClick: () => this.runFactGuard()
      });
    }

    if (result.shouldParticipate && result.route !== "stand_by") {
      actions.push({
        label: "生成研究计划",
        cta: result.route === "start_deep_research",
        onClick: () => this.createResearchPlan()
      });
    }
    actions.push({
      label: "补充要求",
      onClick: () => this.startContextualFollowUp("agent_assist")
    });

    this.appendMessage("agent", summary, { actions });
    this.renderAssistEvidence(result);
  }

  startContextualFollowUp(source = "current") {
    const baseQuery = this.currentContext?.userQuery
      || this.currentTask?.title
      || this.currentTask?.result?.executiveSummary
      || "";
    if (!baseQuery && !this.currentTask?.taskId) {
      this.inputEl.value = "我想继续深入这个问题：";
      this.inputEl.focus();
      return;
    }
    this.pendingPlanRevision = null;
    this.includeActiveNoteContextOnce = false;
    this.inputEl.value = [
      "请基于上一轮结果继续深入：",
      `- 原问题：${compactText(baseQuery, 180)}`,
      "- 我想进一步确认："
    ].join("\n");
    this.inputEl.focus();
    this.appendMessage(
      "agent",
      "我会沿用当前研究上下文。你可以补充要加深的方向，也可以直接生成一条继续研究路径。",
      {
        dedupeKey: `contextual-followup-${source}-${this.currentTask?.taskId || compactText(baseQuery, 40)}`,
        actions: [
          {
            label: "生成继续研究路径",
            cta: true,
            onClick: () => this.createContinuationResearchPlan()
          },
          {
            label: "先让我补充一句",
            onClick: () => this.inputEl.focus()
          }
        ]
      }
    );
  }

  async createContinuationResearchPlan() {
    const baseContext = this.currentContext || {};
    const baseTask = this.currentTask || {};
    const baseTaskId = baseTask.taskId || baseTask.id || baseContext.followUpOfTaskId || "";
    const userInstruction = String(this.inputEl.value || "").trim();
    const baseQuery = baseContext.userQuery
      || baseTask.title
      || baseTask.result?.executiveSummary
      || "上一轮研究结果";
    const nextQuery = buildContextualFollowUpQuery(baseQuery, userInstruction, baseTask);
    this.inputEl.value = "";
    this.appendMessage("user", userInstruction || "请基于上一轮结果生成继续研究路径。");
    this.setActiveStage("decision");
    this.renderLoadingEvidence("正在基于上一轮上下文生成继续研究路径...");
    try {
      const nextContext = {
        ...baseContext,
        userQuery: nextQuery,
        followUpOfTaskId: baseTaskId || baseContext.followUpOfTaskId || undefined,
        sourceReportPath: baseContext.sourceReportPath || baseContext.documentPath || undefined,
        sourceTitle: baseContext.sourceTitle || baseContext.documentTitle || undefined,
        includeCurrentContext: false
      };
      this.currentContext = nextContext;
      const task = await this.plugin.createResearchTask(nextContext);
      this.currentTask = task;
      const path = buildAgentResearchPath(task.plan, nextContext);
      await this.rememberTask(task, {
        pathPreview: path.objective,
        followUpOfTaskId: nextContext.followUpOfTaskId || "",
        sourceReportPath: nextContext.sourceReportPath || ""
      });
      this.appendResearchPlanMessage(path, {
        prefix: "已基于上一轮上下文生成继续研究路径。请确认是否开始："
      });
      this.renderTaskEvidence(task, path);
    } catch (error) {
      this.renderError(error);
      this.appendMessage("agent", error instanceof Error ? error.message : "继续研究路径生成失败。", this.authErrorActions(error));
    }
  }

  async createResearchPlan() {
    if (!this.currentContext) {
      new Notice("没有可用研究上下文，请先发送问题。");
      return;
    }
    this.setActiveStage("decision");
    this.renderLoadingEvidence("正在生成研究路径...");
    try {
      const task = await this.plugin.createResearchTask(this.currentContext);
      this.currentTask = task;
      const path = buildAgentResearchPath(task.plan, this.currentContext);
      await this.rememberTask(task, { pathPreview: path.objective });
      this.appendResearchPlanMessage(path);
      this.renderTaskEvidence(task, path);
    } catch (error) {
      this.renderError(error);
      this.appendMessage("agent", error instanceof Error ? error.message : "研究路径生成失败。", this.authErrorActions(error));
    }
  }

  async reviseResearchPlan(revisionInstruction) {
    const revision = this.pendingPlanRevision;
    this.pendingPlanRevision = null;
    this.includeActiveNoteContextOnce = false;
    if (!revision?.baseContext) {
      this.appendMessage("agent", "没有可修订的上一版研究路径。我会把这次补充当作新问题重新判断。");
      await this.runAgentAssist(revisionInstruction);
      return;
    }

    this.setActiveStage("decision");
    this.renderLoadingEvidence("正在合并你的补充条件，并重新生成研究路径...");
    try {
      const nextContext = buildRevisedResearchContext(
        revision.baseContext,
        revisionInstruction,
        revision.baseTask?.plan
      );
      this.currentContext = nextContext;
      const task = await this.plugin.createResearchTask(nextContext);
      this.currentTask = task;
      const path = buildAgentResearchPath(task.plan, nextContext);
      await this.rememberTask(task, {
        pathPreview: path.objective,
        revisionInstruction
      });
      this.appendResearchPlanMessage(path, {
        prefix: "我已把你的补充条件合并进研究边界，并重生成了一条路径。请确认新版是否更贴近你的意图："
      });
      this.renderTaskEvidence(task, path);
    } catch (error) {
      this.renderError(error);
      this.appendMessage("agent", error instanceof Error ? error.message : "研究路径修订失败。", this.authErrorActions(error));
    }
  }

  appendResearchPlanMessage(path, options = {}) {
    const planText = renderAgentResearchPath(path);
    this.appendMessage("agent", `${options.prefix || "我已经把问题拆成一条可执行研究路径。先确认这条路径是否符合你的意图："}\n\n${planText}`, {
      actions: [
        {
          label: "确认并开始研究",
          cta: true,
          onClick: () => this.confirmAndRunTask()
        },
        {
          label: "调整研究边界",
          onClick: () => this.startPlanRevision()
        },
        {
          label: "先核查关键断言",
          onClick: () => this.runFactGuard()
        }
      ]
    });
  }

  startPlanRevision() {
    if (!this.currentContext) {
      new Notice("没有可调整的研究路径。");
      return;
    }
    this.pendingPlanRevision = {
      baseContext: this.currentContext,
      baseTask: this.currentTask
    };
    this.inputEl.value = [
      "我想调整研究边界：",
      "- 这次研究必须覆盖：",
      "- 这次研究不要展开：",
      "- 最终结论更偏向："
    ].join("\n");
    this.inputEl.focus();
  }

  async confirmAndRunTask() {
    if (!this.currentTask?.taskId) {
      new Notice("没有待确认的研究任务。");
      return;
    }
    const taskId = this.currentTask.taskId;
    if (this.confirmingTaskIds.has(taskId) || this.confirmedTaskIds.has(taskId)) {
      new Notice("这条研究任务已经开始执行。");
      return;
    }
    this.confirmingTaskIds.add(taskId);
    this.setActiveStage("researching");
    this.resetRuntimeNarration();
    try {
      const task = await this.plugin.confirmResearchTask(taskId);
      this.currentTask = task;
      this.confirmedTaskIds.add(taskId);
      await this.rememberTask(task);
      this.appendMessage("agent", [
        "已确认研究路径，开始执行完整研究。",
        "",
        "接下来我会做三件事：",
        "1. 按阶段解释当前进度，而不是只显示百分比。",
        "2. 如果发现明显风险或口径冲突，会在证据面板里单独标出。",
        "3. 完成后先给自检摘要，再给导出和继续追问入口。"
      ].join("\n"), { dedupeKey: `confirm-started-${taskId}` });
      this.renderTaskEvidence(task);
      this.maybeAppendRuntimeUpdate(task, { force: true });
      this.startPolling(task.taskId);
    } catch (error) {
      this.renderError(error);
      this.appendMessage("agent", error instanceof Error ? error.message : "启动研究失败。", this.authErrorActions(error));
    } finally {
      this.confirmingTaskIds.delete(taskId);
    }
  }

  startPolling(taskId) {
    this.stopPolling();
    this.pollTimer = window.setInterval(async () => {
      try {
        const task = await this.plugin.getResearchTask(taskId);
        this.currentTask = task;
        this.renderTaskEvidence(task);
        this.maybeAppendRuntimeUpdate(task);
        if (task.status === "completed") {
          this.stopPolling();
          this.setActiveStage("delivery");
          this.renderCompletedTask(task);
        } else if (task.status === "failed" || task.status === "cancelled") {
          this.stopPolling();
          this.setActiveStage("delivery");
          this.appendMessage("agent", task.errorMessage || "研究任务未完成。");
        } else if (task.runtimeStatus === "synthesizing") {
          this.setActiveStage("checking");
        } else {
          this.setActiveStage("researching");
        }
      } catch (error) {
        this.renderError(error);
      }
    }, 5000);
  }

  stopPolling() {
    if (this.pollTimer) {
      window.clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  renderCompletedTask(task) {
    const taskKey = task.taskId || task.id || "current";
    if (this.runtimeNarration.completedTaskIds.has(taskKey)) return;
    this.runtimeNarration.completedTaskIds.add(taskKey);
    const result = task.result || {};
    const summary = result.executiveSummary || result.summary || "研究完成。";
    const selfCheck = renderCompletionSelfCheck(task);
    this.appendMessage("agent", `研究完成。\n\n${selfCheck}\n\n核心结论：\n${summary}`, {
      actions: [
        {
          label: "重新导出 Markdown",
          onClick: () => this.exportMarkdown({ force: true })
        },
        {
          label: "核查关键数字",
          onClick: () => this.runFactGuard()
        },
        {
          label: "继续追问",
          onClick: () => this.startContextualFollowUp("completed_task")
        }
      ]
    });
    this.renderTaskEvidence(task);
    this.rememberTask(task).catch(() => {});
    this.autoExportAndOpen(task).catch((error) => {
      this.renderError(error);
      this.appendMessage(
        "agent",
        `自动保存研究报告到 Obsidian 失败：${error instanceof Error ? error.message : "未知错误"}。可以用上面的“重新导出 Markdown”按钮手动尝试。`,
        this.authErrorActions(error)
      );
    });
  }

  async autoExportAndOpen(task) {
    const taskId = task?.taskId || task?.id || "";
    if (!taskId) return;
    if (this.autoExportInFlight.has(taskId)) return;
    this.autoExportInFlight.add(taskId);
    try {
      const existingPath = await this.findExistingExportedPath(taskId);
      if (existingPath) {
        const file = this.plugin.app.vault.getAbstractFileByPath(existingPath);
        if (file) {
          await this.plugin.openVaultFile(file);
          this.appendMessage("agent", `研究报告已存在于 Obsidian 中：${existingPath}（已为你打开，未重复生成）。`);
          return;
        }
      }
      const exportContext = this.collectExportContext();
      const filePath = await this.plugin.exportTaskMarkdown(taskId, task, exportContext);
      const followUpExtra = exportContext.followUpOfTaskId
        ? {
            followUpOfTaskId: exportContext.followUpOfTaskId,
            sourceReportPath: exportContext.sourcePath || ""
          }
        : {};
      await this.plugin.upsertHistoryRecord(task, this.currentContext || {}, {
        exportedPath: filePath,
        exportedAt: new Date().toISOString(),
        status: "exported",
        ...followUpExtra
      });
      this.renderHistoryList();
      const file = this.plugin.app.vault.getAbstractFileByPath(filePath);
      if (file) {
        await this.plugin.openVaultFile(file);
      }
      this.appendMessage("agent", `已自动保存研究报告到 Obsidian：${filePath}`);
      new Notice(`研究报告已保存：${filePath}`);
    } finally {
      this.autoExportInFlight.delete(taskId);
    }
  }

  async findExistingExportedPath(taskId) {
    const records = this.plugin.getHistoryRecords();
    const record = records.find((item) => item.taskId === taskId || item.id === taskId);
    if (!record?.exportedPath) return "";
    const file = this.plugin.app.vault.getAbstractFileByPath(record.exportedPath);
    return file ? record.exportedPath : "";
  }

  collectExportContext() {
    const ctx = this.currentContext || {};
    return {
      followUpOfTaskId: ctx.followUpOfTaskId || "",
      sourceTitle: ctx.sourceTitle || ctx.documentTitle || "",
      sourcePath: ctx.sourceReportPath || ctx.documentPath || ""
    };
  }

  resetRuntimeNarration() {
    this.runtimeNarration = {
      lastSignal: "",
      lastMilestone: -1,
      riskSignature: "",
      completedTaskIds: new Set()
    };
  }

  maybeAppendRuntimeUpdate(task, options = {}) {
    const progress = Number(task.progress?.progressPercent || 0);
    const milestone = Math.min(100, Math.floor(progress / 25) * 25);
    const signal = buildTaskRuntimeSignal(task);
    const risks = collectTaskRisks(task);
    const riskSignature = risks.join("|");
    const shouldReportSignal = options.force
      || signal.key !== this.runtimeNarration.lastSignal
      || milestone > this.runtimeNarration.lastMilestone;
    const shouldReportRisk = risks.length && riskSignature !== this.runtimeNarration.riskSignature;

    if (shouldReportSignal && task.status !== "completed") {
      this.runtimeNarration.lastSignal = signal.key;
      this.runtimeNarration.lastMilestone = Math.max(this.runtimeNarration.lastMilestone, milestone);
      this.appendMessage("agent", `进度更新：${signal.chatText}`, {
        dedupeKey: `runtime-${task.taskId || task.id || "current"}-${signal.key}-${milestone}`
      });
    }

    if (shouldReportRisk) {
      this.runtimeNarration.riskSignature = riskSignature;
      this.appendMessage("agent", `我发现了需要留意的风险：\n${risks.slice(0, 3).map((item) => `- ${item}`).join("\n")}`, {
        dedupeKey: `risk-${task.taskId || task.id || "current"}-${riskSignature}`
      });
    }
  }

  async runFactGuard() {
    const claim = this.inputEl.value.trim() || extractFactGuardClaim(this.currentTask) || this.currentContext?.userQuery || "";
    if (!claim) {
      new Notice("没有可核查的断言。");
      return;
    }
    this.setActiveStage("checking");
    this.renderLoadingEvidence("正在运行 Fact Guard...");
    try {
      const context = {
        ...(this.currentContext || {}),
        claim,
        userQuery: this.currentContext?.userQuery || claim
      };
      const result = await this.plugin.invokeFactGuard(context);
      this.appendMessage("agent", renderFactGuardSummary(result), {
        actions: [
        {
          label: "继续深入",
          onClick: () => this.startContextualFollowUp("fact_guard")
        }
      ]
    });
      this.renderFactGuardEvidence(result);
    } catch (error) {
      this.renderError(error);
      this.appendMessage("agent", error instanceof Error ? error.message : "Fact Guard 失败。", this.authErrorActions(error));
    }
  }

  async exportMarkdown(options = {}) {
    if (!this.currentTask?.taskId) {
      new Notice("没有可导出的研究任务。");
      return;
    }
    try {
      if (!options.force) {
        const existing = await this.findExistingExportedPath(this.currentTask.taskId);
        if (existing) {
          const file = this.plugin.app.vault.getAbstractFileByPath(existing);
          if (file) await this.plugin.openVaultFile(file);
          new Notice(`已存在导出文件：${existing}`);
          this.appendMessage("agent", `已存在 Obsidian 笔记：${existing}（已为你打开，未重复生成）。`);
          return;
        }
      }
      const exportContext = this.collectExportContext();
      const path = await this.plugin.exportTaskMarkdown(
        this.currentTask.taskId,
        this.currentTask,
        exportContext
      );
      const followUpExtra = exportContext.followUpOfTaskId
        ? {
            followUpOfTaskId: exportContext.followUpOfTaskId,
            sourceReportPath: exportContext.sourcePath || ""
          }
        : {};
      await this.rememberTask(this.currentTask, {
        exportedPath: path,
        exportedAt: new Date().toISOString(),
        status: "exported",
        ...followUpExtra
      });
      const file = this.plugin.app.vault.getAbstractFileByPath(path);
      if (file) await this.plugin.openVaultFile(file);
      new Notice(`已导出：${path}`);
      this.appendMessage("agent", `已生成 Obsidian 笔记：${path}`);
    } catch (error) {
      this.renderError(error);
      this.appendMessage("agent", error instanceof Error ? error.message : "导出失败。", this.authErrorActions(error));
    }
  }

  async rememberTask(task, extra = {}) {
    await this.plugin.upsertHistoryRecord(task, this.currentContext || {}, extra);
    this.renderHistoryList();
  }

  setStages(stages, activeKey) {
    this.stages = stages;
    this.setActiveStage(activeKey);
  }

  setActiveStage(activeKey) {
    if (!this.stageEl || !this.stages) return;
    if (this.flowEl) {
      if (!activeKey || activeKey === "idle") {
        this.flowEl.addClass("is-hidden");
      } else {
        this.flowEl.removeClass("is-hidden");
        this.flowEl.dataset.stage = activeKey;
      }
    }
    this.stageEl.empty();
    const activeIndex = this.stages.findIndex(([key]) => key === activeKey);
    this.stages.forEach(([key, title, desc]) => {
      const stageIndex = this.stages.findIndex(([candidate]) => candidate === key);
      const isActive = key === activeKey;
      const isComplete = activeIndex > -1 && stageIndex < activeIndex;
      const item = this.stageEl.createDiv({
        cls: `ra-stage ${isActive ? "is-active" : ""} ${isComplete ? "is-complete" : ""}`
      });
      const dot = item.createDiv({ cls: "ra-stage-dot" });
      if (isComplete) {
        setIcon(dot, "check");
      } else if (isActive) {
        setIcon(dot, stageIcon(activeKey));
      }
      item.createDiv({ cls: "ra-stage-title", text: title });
      item.createDiv({ cls: "ra-stage-desc", text: desc });
    });
  }

  renderEmptyEvidence() {
    this.evidenceEl.empty();
    this.evidenceEl.createDiv({ cls: "ra-empty", text: "还没有证据。发送问题后，这里会显示触发理由、来源、风险和结果。" });
  }

  renderHistoryList() {
    if (!this.historyEl) return;
    this.historyEl.empty();
    const records = this.plugin.getHistoryRecords().slice(0, 8);
    if (!records.length) {
      this.historyEl.addClass("is-hidden");
      return;
    }
    this.historyEl.removeClass("is-hidden");
    const header = this.historyEl.createDiv({ cls: "ra-history-header" });
    header.createEl("h3", { text: "历史调研" });
    header.createEl("p", { text: "最近的研究路径、完成结果和导出笔记。" });
    const list = this.historyEl.createDiv({ cls: "ra-history-list" });
    records.forEach((record) => {
      const item = list.createDiv({ cls: "ra-history-item" });
      const title = item.createDiv({ cls: "ra-history-title", text: compactText(record.title || "未命名研究", 72) });
      title.addEventListener("click", () => this.openHistoryRecord(record));
      item.createDiv({
        cls: "ra-history-meta",
        text: `${historyStatusLabel(record.status)} · ${formatShortDate(record.updatedAt || record.createdAt)}`
      });
      if (record.summary) {
        item.createDiv({ cls: "ra-history-summary", text: compactText(record.summary, 120) });
      }
      const actions = item.createDiv({ cls: "ra-history-actions" });
      const openButton = actions.createEl("button", { text: "查看" });
      openButton.addEventListener("click", () => this.openHistoryRecord(record));
      const continueButton = actions.createEl("button", { text: "继续追问" });
      continueButton.addEventListener("click", () => {
        this.startHistoryFollowUp(record);
      });
    });
  }

  startHistoryFollowUp(record) {
    this.pendingPlanRevision = null;
    this.includeActiveNoteContextOnce = false;
    this.currentContext = {
      ...(this.currentContext || {}),
      userQuery: record.query || record.title || "历史调研",
      followUpOfTaskId: record.taskId || record.id || "",
      sourceReportPath: record.exportedPath || record.sourceReportPath || "",
      sourceTitle: record.title || ""
    };
    this.currentTask = {
      ...(this.currentTask || {}),
      taskId: record.taskId || record.id || "",
      title: record.title || ""
    };
    this.inputEl.value = [
      `基于历史调研《${record.title || "未命名研究"}》，我想继续追问：`,
      "- "
    ].join("\n");
    this.inputEl.focus();
    this.appendMessage("agent", "我已把这条历史调研作为追问上下文。你可以补充问题，也可以直接生成继续研究路径。", {
      dedupeKey: `history-followup-${record.taskId || record.id || record.title}`,
      actions: [
        {
          label: "生成继续研究路径",
          cta: true,
          onClick: () => this.createContinuationResearchPlan()
        }
      ]
    });
  }

  resolveFollowUpSourceLabel(record) {
    if (record.sourceTitle) return `《${record.sourceTitle}》`;
    if (record.sourceReportPath) {
      const linked = this.plugin.findHistoryRecordByExportedPath(record.sourceReportPath);
      if (linked?.title) return `《${linked.title}》`;
      return record.sourceReportPath;
    }
    if (record.followUpOfTaskId) {
      const linked = this.plugin.getHistoryRecords().find(
        (item) => item.taskId === record.followUpOfTaskId || item.id === record.followUpOfTaskId
      );
      if (linked?.title) return `《${linked.title}》`;
      return `taskId ${record.followUpOfTaskId.slice(0, 8)}…`;
    }
    return "未知来源";
  }

  async openHistoryRecord(record) {
    if (record.exportedPath) {
      const file = this.plugin.app.vault.getAbstractFileByPath(record.exportedPath);
      if (file) {
        await this.plugin.openVaultFile(file);
        return;
      }
      new Notice(`已记录的导出文件不存在：${record.exportedPath}`);
    }
    this.inputEl.value = `请继续这个历史研究任务：${record.title || record.query || ""}`;
    this.inputEl.focus();
    new Notice("这条历史还没有导出笔记，已放入输入框方便继续。");
  }

  renderLoadingEvidence(text) {
    this.evidenceEl.empty();
    this.evidenceEl.createDiv({ cls: "ra-loading", text });
  }

  renderAssistEvidence(result) {
    this.evidenceEl.empty();
    this.renderKeyValue("建议路线", routeLabel(result.route));
    this.renderKeyValue("置信度", result.confidence || "unknown");
    this.renderList("触发原因", result.triggerReasons || []);
    this.renderList("建议追问", result.suggestedQuestions || []);
    this.renderList("限制", result.answer?.limitations || []);
    this.renderEvidenceItems(result.evidenceItems || []);
  }

  renderTaskEvidence(task, path = null) {
    this.evidenceEl.empty();
    this.renderKeyValue("任务状态", taskStatusLabel(task.status));
    this.renderKeyValue("当前阶段", task.progress?.currentStepLabel || task.progressText || task.runtimeStatus || "");
    this.renderProgress(task.progress?.progressPercent || 0);
    this.renderRuntimeObservation(task);
    if (task.plan) {
      if (path) this.renderAgentPathEvidence(path);
      this.renderPlanEvidence(task.plan);
    }
    if (task.result) {
      this.renderResultEvidence(task.result);
    }
  }

  renderResultEvidence(result) {
    this.renderList("关键发现", result.keyFindings || []);
    this.renderList("不确定项", result.uncertainties || []);
    this.renderEvidenceItems(result.evidenceItems || []);
    const agent = result.agent;
    if (agent) {
      this.renderKeyValue("自检风险", agent.finalRiskLevel || "unknown");
      this.renderList("建议向用户追问", agent.userInteraction?.suggestedQuestions || []);
    }
  }

  renderRuntimeObservation(task) {
    const signal = buildTaskRuntimeSignal(task);
    const risks = collectTaskRisks(task);
    const card = this.evidenceEl.createDiv({ cls: "ra-runtime-card" });
    card.createEl("h4", { text: "Agent 观察" });
    card.createDiv({ cls: "ra-runtime-line", text: signal.panelText });
    card.createDiv({ cls: "ra-runtime-next", text: signal.nextAction });
    if (risks.length) {
      const riskTitle = card.createDiv({ cls: "ra-runtime-risk-title", text: "需要留意" });
      setIcon(riskTitle.createSpan({ cls: "ra-runtime-risk-icon" }), "alert-triangle");
      const list = card.createEl("ul", { cls: "ra-side-list" });
      risks.slice(0, 4).forEach((item) => list.createEl("li", { text: compactText(item, 160) }));
    }
  }

  renderFactGuardEvidence(result) {
    this.evidenceEl.empty();
    this.renderKeyValue("核查结论", result.verdict || result.status || "unknown");
    this.renderList("理由", result.reasons || result.keyFindings || []);
    this.renderList("仍需核查", result.uncertainties || result.openQuestions || []);
    this.renderEvidenceItems(result.evidenceItems || []);
  }

  renderError(error) {
    this.evidenceEl.empty();
    this.evidenceEl.createDiv({
      cls: "ra-error",
      text: error instanceof Error ? error.message : "发生未知错误。"
    });
  }

  renderKeyValue(label, value) {
    const row = this.evidenceEl.createDiv({ cls: "ra-kv" });
    row.createSpan({ text: label });
    row.createEl("strong", { text: String(value || "-") });
  }

  renderProgress(value) {
    const wrap = this.evidenceEl.createDiv({ cls: "ra-progress" });
    const bar = wrap.createDiv();
    bar.style.width = `${Math.max(0, Math.min(100, Number(value) || 0))}%`;
    wrap.createSpan({ text: `${Math.round(Number(value) || 0)}%` });
  }

  renderList(title, items) {
    const clean = (items || []).map((item) => String(item || "").trim()).filter(Boolean);
    if (!clean.length) return;
    this.evidenceEl.createEl("h4", { text: `${title}${clean.length > 8 ? ` · ${clean.length}` : ""}` });
    const list = this.evidenceEl.createEl("ul", { cls: "ra-side-list" });
    clean.slice(0, 8).forEach((item) => list.createEl("li", { text: compactText(item, 180) }));
  }

  renderPlanEvidence(plan) {
    const sections = getPlanSections(plan);
    if (sections.objective) {
      this.renderKeyValue("研究目标", compactText(sections.objective, 120));
    }
    this.renderList("要回答的问题", sections.subquestions);
    this.renderList("交付物", sections.deliverables);
    this.renderList("证据策略", sections.evidenceStrategy);
    this.renderList("已识别风险", sections.risks);
  }

  renderAgentPathEvidence(path) {
    const card = this.evidenceEl.createDiv({ cls: "ra-path-card" });
    card.createEl("h4", { text: "执行前检查" });
    if (path.revisionInstruction) {
      card.createDiv({
        cls: "ra-path-revision",
        text: `已合并边界：${compactText(path.revisionInstruction, 180)}`
      });
    }
    const checklist = card.createEl("ul", { cls: "ra-path-checklist" });
    path.confirmationChecklist.forEach((item) => {
      const row = checklist.createEl("li");
      const icon = row.createSpan({ cls: "ra-path-check" });
      setIcon(icon, "check");
      row.createSpan({ text: item });
    });

    if (path.userControl.length) {
      card.createEl("h4", { text: "你仍可控制" });
      const controls = card.createDiv({ cls: "ra-path-controls" });
      path.userControl.forEach((item) => controls.createSpan({ text: item }));
    }
  }

  renderEvidenceItems(items) {
    if (!items?.length) return;
    this.evidenceEl.createEl("h4", { text: `来源 · ${items.length}` });
    items.slice(0, 6).forEach((item) => {
      const card = this.evidenceEl.createEl("details", { cls: "ra-source-card" });
      const summary = card.createEl("summary", { cls: "ra-source-title" });
      summary.setText(item.title || "未命名来源");
      const url = item.locator?.url || item.locator?.filePath || item.id || "";
      if (url) card.createDiv({ cls: "ra-source-url", text: url });
      if (item.snippet) card.createDiv({ cls: "ra-source-snippet", text: compactText(item.snippet, 520) });
    });
  }
}

class ResearchAgentSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Research Agent 设置" });
    containerEl.createEl("p", {
      text: "这是对话式研究插件。你可以在这里直接登录 Deep Research Cloud；也可以导入旧 Deep Research 插件的登录状态。"
    });

    this.renderConnectionStatus(containerEl);

    new Setting(containerEl)
      .setName("云端服务地址")
      .setDesc("如果没有特殊说明，使用服务提供方给你的地址。未写 https:// 时会自动补全。")
      .addText((text) => text
        .setValue(this.plugin.settings.controlPlaneBaseUrl)
        .onChange(async (value) => {
          this.plugin.settings.controlPlaneBaseUrl = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("账号邮箱")
      .addText((text) => text
        .setValue(this.plugin.settings.controlPlaneEmail)
        .onChange(async (value) => {
          this.plugin.settings.controlPlaneEmail = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("账号密码")
      .setDesc("密码只保存在当前 Obsidian 会话内存中，不会写入 data.json。")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("输入 Deep Research Cloud 密码")
          .setValue(this.plugin.getControlPlanePassword())
          .onChange((value) => {
            this.plugin.setControlPlanePassword(value);
          });
      });

    new Setting(containerEl)
      .setName("邀请码（新用户注册用）")
      .setDesc("已有账号登录不需要填写；新用户注册时填写服务提供方给你的邀请码。")
      .addText((text) => text
        .setPlaceholder("已有账号可留空")
        .setValue(this.plugin.settings.controlPlaneInviteCode || "")
        .onChange(async (value) => {
          this.plugin.settings.controlPlaneInviteCode = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("连接动作")
      .setDesc("已有账号点登录；新用户填写邀请码后点注册并登录。")
      .addButton((button) => button
        .setButtonText("登录 Deep Research Cloud")
        .setCta()
        .onClick(async () => {
          button.setDisabled(true);
          button.setButtonText("登录中...");
          try {
            await this.plugin.loginCloudAccount();
            new Notice("Research Agent 已登录 Deep Research Cloud。");
            this.display();
          } catch (error) {
            new Notice(error instanceof Error ? error.message : "登录失败。", 6000);
          } finally {
            button.setDisabled(false);
            button.setButtonText("登录 Deep Research Cloud");
          }
        }))
      .addButton((button) => button
        .setButtonText("用邀请码注册并登录")
        .onClick(async () => {
          button.setDisabled(true);
          button.setButtonText("注册中...");
          try {
            await this.plugin.registerCloudAccount();
            new Notice("Research Agent 已注册并登录 Deep Research Cloud。");
            this.display();
          } catch (error) {
            new Notice(error instanceof Error ? error.message : "注册失败。", 6000);
          } finally {
            button.setDisabled(false);
            button.setButtonText("用邀请码注册并登录");
          }
        }))
      .addExtraButton((button) => button
        .setIcon("refresh-cw")
        .setTooltip("刷新登录状态")
        .onClick(async () => {
          try {
            await this.plugin.refreshBootstrap();
            new Notice("登录状态已刷新。");
            this.display();
          } catch (error) {
            new Notice(error instanceof Error ? error.message : "刷新失败。", 6000);
          }
        }))
      .addExtraButton((button) => button
        .setIcon("log-out")
        .setTooltip("退出登录")
        .onClick(async () => {
          await this.plugin.clearCloudSession();
          new Notice("已退出 Research Agent 登录状态。");
          this.display();
        }));

    new Setting(containerEl)
      .setName("导出文件夹")
      .setDesc("Research Agent 导出的 Markdown 会写入这里。")
      .addText((text) => text
        .setValue(this.plugin.settings.outputFolder)
        .onChange(async (value) => {
          this.plugin.settings.outputFolder = value.trim() || DEFAULT_SETTINGS.outputFolder;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("从旧 Deep Research 导入登录状态")
      .setDesc("只读取旧插件 data.json 的云端地址、邮箱、refresh token 和导出目录。")
      .addButton((button) => button
        .setButtonText("导入")
        .setCta()
        .onClick(async () => {
          await this.plugin.importLegacyResearchSettings();
          new Notice("已导入旧 Deep Research 的云端配置。");
          this.display();
        }));
  }

  renderConnectionStatus(containerEl) {
    const status = containerEl.createDiv({ cls: "ra-settings-status" });
    status.createEl("h3", { text: "当前连接状态" });
    if (this.plugin.bootstrap?.user) {
      const user = this.plugin.bootstrap.user;
      const plan = user.planType ? ` · 套餐 ${user.planType}` : "";
      status.createEl("p", { text: `已登录：${user.nickname || user.email}${plan}` });
      return;
    }
    if (this.plugin.settings.controlPlaneRefreshToken) {
      status.createEl("p", {
        text: this.plugin.bootstrapError
          ? `已保存登录会话，但刷新失败：${this.plugin.bootstrapError}`
          : "已保存登录会话。点击刷新状态可确认当前是否可用。"
      });
      return;
    }
    status.createEl("p", { text: "尚未登录。请填写服务地址、账号邮箱和密码后点击登录。" });
  }
}

function parseJson(text) {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function normalizeCloudBaseUrl(value) {
  let text = String(value || "").trim();
  if (!text) {
    throw new Error("请先填写云端服务地址。");
  }
  if (!/^https?:\/\//i.test(text)) {
    text = `https://${text}`;
  }
  try {
    const url = new URL(text);
    return url.toString().replace(/\/+$/, "");
  } catch {
    throw new Error("云端服务地址格式不正确，请检查是否多输入了字符。");
  }
}

async function ensureFolder(app, folderPath) {
  const parts = normalizePath(folderPath).split("/").filter(Boolean);
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    if (!app.vault.getAbstractFileByPath(current)) {
      await app.vault.createFolder(current);
    }
  }
}

function ensureMarkdownFileName(name) {
  const cleaned = String(name || "research-agent-report.md")
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return cleaned.toLowerCase().endsWith(".md") ? cleaned : `${cleaned || "research-agent-report"}.md`;
}

async function uniqueVaultPath(app, path) {
  if (!app.vault.getAbstractFileByPath(path)) return path;
  const dot = path.toLowerCase().endsWith(".md") ? path.slice(0, -3) : path;
  for (let index = 2; index < 100; index += 1) {
    const candidate = `${dot}-${index}.md`;
    if (!app.vault.getAbstractFileByPath(candidate)) return candidate;
  }
  return `${dot}-${Date.now()}.md`;
}

function buildHistoryRecord(task = {}, context = {}, extra = {}) {
  const result = task.result || {};
  const plan = task.plan || {};
  const id = task.taskId || task.id || extra.taskId || "";
  const title = compactText(
    extra.title
      || getPlanSections(plan).objective
      || context.planRevision?.originalUserQuery
      || context.userQuery
      || result.title
      || result.executiveSummary
      || "未命名研究",
    90
  );
  return {
    id,
    title,
    query: context.planRevision?.originalUserQuery || context.userQuery || "",
    status: extra.status || task.status || "unknown",
    taskId: id,
    createdAt: task.createdAt || extra.createdAt || new Date().toISOString(),
    summary: compactText(
      extra.summary
        || result.executiveSummary
        || result.summary
        || extra.pathPreview
        || getPlanSections(plan).stopCondition
        || "",
      160
    ),
    riskLevel: result.agent?.finalRiskLevel || result.selfCheck?.finalRiskLevel || result.riskLevel || "",
    exportedPath: extra.exportedPath || "",
    exportedAt: extra.exportedAt || "",
    revisionInstruction: extra.revisionInstruction || context.planRevision?.userInstruction || "",
    followUpOfTaskId: extra.followUpOfTaskId || context.followUpOfTaskId || "",
    sourceReportPath: extra.sourceReportPath || context.sourceReportPath || "",
    sourceTitle: extra.sourceTitle || context.sourceTitle || ""
  };
}

function buildResearchNoteMarkdown({
  task = {},
  cloudMarkdown = "",
  exportedAt = "",
  followUpOfTaskId = "",
  sourceTitle = "",
  sourcePath = ""
}) {
  const result = task?.result || {};
  const plan = task?.plan || {};
  const sections = getPlanSections(plan);
  const title = compactText(sections.objective || result.title || result.executiveSummary || "Research Agent 调研记录", 120);
  const risks = collectTaskRisks(task).slice(0, 8);
  const findings = normalizeList(result.keyFindings || result.findings).slice(0, 12);
  const uncertainties = normalizeList(result.uncertainties || result.openQuestions).slice(0, 10);
  const rawSources = result.evidenceItems || result.sources || [];
  const evidenceItems = Array.isArray(rawSources) ? rawSources.slice(0, 12) : [];
  const selfCheck = renderCompletionSelfCheck(task);
  const createdAt = task.createdAt || exportedAt || new Date().toISOString();
  const frontmatter = [
    "---",
    "type: research-agent-report",
    `title: ${yamlString(title)}`,
    `taskId: ${yamlString(task.taskId || task.id || "")}`,
    `status: ${yamlString(task.status || "")}`,
    `riskLevel: ${yamlString(result.agent?.finalRiskLevel || result.selfCheck?.finalRiskLevel || result.riskLevel || "")}`,
    `createdAt: ${yamlString(createdAt)}`,
    `exportedAt: ${yamlString(exportedAt)}`
  ];
  if (sourceTitle) frontmatter.push(`sourceTitle: ${yamlString(sourceTitle)}`);
  if (sourcePath) frontmatter.push(`sourcePath: ${yamlString(sourcePath)}`);
  if (followUpOfTaskId) frontmatter.push(`followUpOfTaskId: ${yamlString(followUpOfTaskId)}`);
  frontmatter.push(
    "tags:",
    "  - research-agent",
    "  - deep-research",
    "---"
  );
  const lines = [
    ...frontmatter,
    "",
    `# ${title}`,
    "",
    "## 1. 摘要",
    "",
    result.executiveSummary || result.summary || "暂无摘要。",
    "",
    "## 2. 研究问题",
    "",
    markdownList(sections.subquestions.length ? sections.subquestions : [sections.objective || title]),
    "",
    "## 3. 关键发现",
    "",
    markdownList(findings.length ? findings : ["完整发现见下方原始报告。"]),
    "",
    "## 4. 证据与来源",
    "",
    evidenceItems.length ? sourceListMarkdown(evidenceItems) : "完整来源见下方原始报告。",
    "",
    "## 5. 风险与不确定项",
    "",
    markdownList([ ...risks, ...uncertainties ].length ? [ ...risks, ...uncertainties ] : ["暂无明确风险项；仍建议复查关键来源。"]),
    "",
    "## 6. Agent 自检",
    "",
    selfCheck,
    "",
    "## 7. 下一步问题",
    "",
    markdownList(normalizeList(result.agent?.userInteraction?.suggestedQuestions).slice(0, 6)),
    "",
    "## 8. 原始报告",
    "",
    cloudMarkdown || "暂无原始报告内容。"
  ];
  return lines.join("\n");
}

function yamlString(value) {
  return JSON.stringify(String(value || ""));
}

function markdownList(items) {
  const clean = normalizeList(items).filter(Boolean);
  if (!clean.length) return "- 暂无";
  return clean.map((item) => `- ${String(item).replace(/\n+/g, " ").trim()}`).join("\n");
}

function sourceListMarkdown(items) {
  const clean = (items || []).filter(Boolean);
  if (!clean.length) return "- 暂无";
  return clean.map((item) => {
    if (typeof item === "string") return `- ${item}`;
    const title = item.title || item.name || item.id || "未命名来源";
    const url = item.locator?.url || item.url || item.locator?.filePath || "";
    const snippet = item.snippet ? `：${compactText(item.snippet, 160)}` : "";
    return `- ${url ? `[${title}](${url})` : title}${snippet}`;
  }).join("\n");
}

function historyStatusLabel(status) {
  if (status === "exported") return "已导出";
  return taskStatusLabel(status);
}

function formatShortDate(value) {
  if (!value) return "未知时间";
  try {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "未知时间";
    return date.toLocaleString("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    });
  } catch {
    return "未知时间";
  }
}

function routeLabel(route) {
  return {
    stand_by: "暂不介入",
    answer_now: "先给简短判断",
    ask_clarification: "先追问澄清",
    run_fact_guard: "先核查断言",
    start_deep_research: "升级完整研究"
  }[route] || route || "unknown";
}

function stageIcon(stage) {
  return {
    understanding: "sparkles",
    decision: "message-square",
    researching: "search",
    checking: "shield-check",
    delivery: "check-circle",
  }[stage] || "sparkles";
}

function shouldCreateResearchPlan(result = {}) {
  return result.route !== "ask_clarification";
}

function taskStatusLabel(status) {
  return {
    awaiting_confirmation: "待确认",
    drafting_plan: "生成研究路径",
    running: "研究中",
    synthesizing: "整理结果",
    completed: "已完成",
    failed: "失败",
    cancelled: "已取消"
  }[status] || status || "unknown";
}

function flattenPlan(plan) {
  const items = [];
  const visit = (value, prefix = "") => {
    if (!value) return;
    if (typeof value === "string") {
      items.push(prefix ? `${prefix}: ${value}` : value);
      return;
    }
    if (Array.isArray(value)) {
      value.slice(0, 8).forEach((item) => visit(item, prefix));
      return;
    }
    if (typeof value === "object") {
      Object.entries(value).forEach(([key, item]) => visit(item, key));
    }
  };
  visit(plan);
  return items;
}

function renderPlanSummary(plan, fallbackQuestion = "") {
  const sections = getPlanSections(plan);
  const lines = [];
  lines.push(`研究目标：${sections.objective || fallbackQuestion || "确认问题边界并产出可执行结论。"}`);
  if (sections.subquestions.length) {
    lines.push("");
    lines.push("我会优先回答：");
    sections.subquestions.slice(0, 4).forEach((item, index) => {
      lines.push(`${index + 1}. ${item}`);
    });
  }
  if (sections.deliverables.length) {
    lines.push("");
    lines.push("预计交付：");
    sections.deliverables.slice(0, 3).forEach((item) => lines.push(`- ${item}`));
  }
  if (sections.risks.length) {
    lines.push("");
    lines.push(`已识别风险：${sections.risks.slice(0, 2).join("；")}`);
  }
  if (sections.stopCondition) {
    lines.push("");
    lines.push(`停止条件：${sections.stopCondition}`);
  }
  return lines.join("\n");
}

function buildAgentResearchPath(plan, context = {}) {
  const sections = getPlanSections(plan);
  const objective = sections.objective || context.userQuery || "确认问题边界并产出可执行结论。";
  const subquestions = sections.subquestions.length
    ? sections.subquestions
    : inferResearchQuestions(objective);
  const deliverables = sections.deliverables.length
    ? sections.deliverables
    : ["一份结构化结论", "证据强弱分层", "风险与下一步建议"];
  const evidenceStrategy = sections.evidenceStrategy.length
    ? sections.evidenceStrategy
    : ["优先查找可追溯来源", "交叉核对关键数字、案例和时间线", "把无法证实的内容单独标为不确定"];
  const risks = sections.risks.length
    ? sections.risks
    : ["如果问题边界过宽，结论会先偏框架化；需要在执行后继续收窄。"];

  return {
    objective,
    decisionLens: buildDecisionLens(objective),
    revisionInstruction: context.planRevision?.userInstruction || "",
    phases: [
      {
        title: "锁定判断口径",
        detail: "先把问题拆成少数必须回答的判断题，避免研究变成资料堆叠。",
        items: subquestions.slice(0, 4)
      },
      {
        title: "收集与分层证据",
        detail: "按来源可靠性、时效性和可复核性整理证据，区分事实、推断和观点。",
        items: evidenceStrategy.slice(0, 4)
      },
      {
        title: "自检与补强",
        detail: "专门检查反例、口径冲突、数据缺口和可能误导用户的断言。",
        items: risks.slice(0, 3)
      },
      {
        title: "交付可用结论",
        detail: "输出可以直接进入创作、产品或决策讨论的结论，而不是只给资料摘要。",
        items: deliverables.slice(0, 4)
      }
    ],
    confirmationChecklist: buildConfirmationChecklist(sections, context),
    userControl: [
      "确认后启动完整 Deep Research",
      "调整边界后重新生成路径",
      "先用 Fact Guard 核查关键断言"
    ],
    stopCondition: sections.stopCondition || "当关键问题都有可追溯证据、主要不确定项已标明时停止。"
  };
}

function renderAgentResearchPath(path) {
  const lines = [
    `目标：${path.objective}`,
    `判断口径：${path.decisionLens}`,
    "",
    "执行路径："
  ];
  if (path.revisionInstruction) {
    lines.splice(2, 0, `本次修订：${compactText(path.revisionInstruction, 180)}`);
  }
  path.phases.forEach((phase, index) => {
    lines.push(`${index + 1}. ${phase.title}：${phase.detail}`);
    phase.items.slice(0, 3).forEach((item) => lines.push(`   - ${item}`));
  });
  lines.push("");
  lines.push("确认前我会检查：");
  path.confirmationChecklist.forEach((item) => lines.push(`- ${item}`));
  lines.push("");
  lines.push(`停止条件：${path.stopCondition}`);
  return lines.join("\n");
}

function buildDecisionLens(objective) {
  const text = String(objective || "");
  if (/剧本|编剧|短剧|影视|创作|选题/.test(text)) {
    return "优先服务创作决策：题材是否值得做、怎么做更稳、哪些证据会影响判断。";
  }
  if (/产品|插件|用户|体验|功能|MVP/i.test(text)) {
    return "优先服务产品决策：用户问题、可行方案、风险和最小可验证版本。";
  }
  if (/投资|商业|市场|行业|增长/.test(text)) {
    return "优先服务商业判断：趋势是否成立、机会边界、关键风险和可行动建议。";
  }
  return "优先服务决策：先回答能改变行动的问题，再补充背景资料。";
}

function inferResearchQuestions(objective) {
  const base = compactText(objective, 140) || "这个问题";
  return [
    `${base} 的核心判断标准是什么？`,
    "现有公开证据支持还是削弱这个判断？",
    "有哪些反例、风险或尚不能下结论的地方？",
    "最终应该给用户什么可执行建议？"
  ];
}

function buildConfirmationChecklist(sections, context = {}) {
  const checks = [];
  if (context.planRevision?.userInstruction) {
    checks.push("已合并你刚补充的研究边界。");
  }
  checks.push(sections.subquestions.length ? "研究问题已经拆成可回答的小问题。" : "当前问题会先由 Agent 自动拆解，可能需要执行后继续收窄。");
  checks.push(sections.evidenceStrategy.length ? "已经有明确证据收集方向。" : "证据策略将优先使用可追溯公开来源，并标出来源限制。");
  checks.push(sections.deliverables.length ? "交付物已经明确。" : "默认交付结构化结论、证据分层和下一步建议。");
  if (context.includeCurrentContext) {
    checks.push("本次会使用你确认带入的当前笔记上下文。");
  } else {
    checks.push("本次不会默认读取当前笔记内容。");
  }
  return checks;
}

function buildRevisedResearchContext(baseContext, revisionInstruction, previousPlan) {
  const baseQuery = String(baseContext?.userQuery || "").trim();
  const revision = String(revisionInstruction || "").trim();
  const previousPlanSummary = renderPlanSummary(previousPlan, baseQuery);
  const mergedQuery = [
    baseQuery,
    "",
    "用户补充的研究边界：",
    revision,
    "",
    "请基于补充条件重新生成研究路径；如果补充条件与上一版计划冲突，以用户补充条件为准。"
  ].join("\n").trim();

  return {
    ...(baseContext || {}),
    userQuery: mergedQuery,
    planRevision: {
      originalUserQuery: baseQuery,
      userInstruction: revision,
      previousPlanSummary
    }
  };
}

function buildTaskRuntimeSignal(task = {}) {
  const status = task.status || "unknown";
  const runtime = task.runtimeStatus || "";
  const label = task.progress?.currentStepLabel || task.progressText || runtime || taskStatusLabel(status);
  const progress = Math.round(Number(task.progress?.progressPercent || 0));
  const key = [status, runtime, label, Math.floor(progress / 25)].join("|");

  if (status === "awaiting_confirmation") {
    return {
      key,
      chatText: "研究路径还在等待确认；确认前不会启动长任务。",
      panelText: "当前只是待确认状态，尚未消耗完整研究任务。",
      nextAction: "下一步：确认开始、调整边界，或先核查关键断言。"
    };
  }
  if (status === "drafting_plan") {
    return {
      key,
      chatText: "正在把问题整理成可执行研究路径。",
      panelText: "Agent 正在组织问题、证据策略和交付物。",
      nextAction: "下一步：生成可确认的研究路径。"
    };
  }
  if (runtime === "synthesizing" || status === "synthesizing") {
    return {
      key,
      chatText: `已进入整理与自检阶段（${progress}%）。我会把证据、反例和不确定项分开处理。`,
      panelText: "正在综合证据并做自检，重点检查结论是否过度外推。",
      nextAction: "下一步：产出结论、风险和导出入口。"
    };
  }
  if (status === "completed") {
    return {
      key,
      chatText: "研究已完成，正在整理交付结果。",
      panelText: "研究完成，结果已经进入交付状态。",
      nextAction: "下一步：查看自检摘要、导出 Markdown，或继续追问。"
    };
  }
  if (status === "failed" || status === "cancelled") {
    return {
      key,
      chatText: "研究任务没有正常完成，需要查看错误或重新调整路径。",
      panelText: "任务已停止，当前结果不能作为完整研究交付。",
      nextAction: "下一步：查看错误原因，调整边界后重试。"
    };
  }
  if (status === "running") {
    return {
      key,
      chatText: `正在收集和筛选证据（${progress}%）。当前阶段：${label || "研究中"}。`,
      panelText: `正在执行完整研究：${label || "收集证据与核对来源"}。`,
      nextAction: "下一步：继续收集证据；若发现口径冲突，会单独标出。"
    };
  }
  return {
    key,
    chatText: `当前状态：${taskStatusLabel(status)}。${label || ""}`.trim(),
    panelText: label || `当前状态：${taskStatusLabel(status)}`,
    nextAction: "下一步：等待任务状态更新。"
  };
}

function collectTaskRisks(task = {}) {
  const result = task.result || {};
  const agent = result.agent || {};
  const selfCheck = result.selfCheck || {};
  return dedupe([
    ...normalizeList(task.risks),
    ...normalizeList(task.warnings),
    ...normalizeList(task.progress?.risks),
    ...normalizeList(task.progress?.warnings),
    ...normalizeList(result.uncertainties),
    ...normalizeList(result.limitations),
    ...normalizeList(selfCheck.risks),
    ...normalizeList(selfCheck.limitations),
    ...normalizeList(agent.risks),
    ...normalizeList(agent.limitations),
    ...normalizeList(agent.userInteraction?.suggestedQuestions).map((item) => `建议追问：${item}`)
  ]).filter(Boolean);
}

function renderCompletionSelfCheck(task = {}) {
  const result = task.result || {};
  const agent = result.agent || {};
  const selfCheck = result.selfCheck || {};
  const risks = collectTaskRisks(task).slice(0, 3);
  const suspiciousClaims = normalizeList(selfCheck.suspiciousClaims).slice(0, 3);
  const questions = normalizeList(agent.userInteraction?.suggestedQuestions).slice(0, 2);
  const riskLevel = agent.finalRiskLevel || selfCheck.finalRiskLevel || result.riskLevel || "未标明";
  const lines = [`自检摘要：风险等级 ${riskLevel}`];

  if (risks.length) {
    lines.push("需要注意：");
    risks.forEach((item) => lines.push(`- ${item}`));
  } else {
    lines.push("未发现需要前置打断用户的高风险项，但仍应查看来源和不确定项。");
  }
  if (suspiciousClaims.length) {
    lines.push("建议优先核查的断言：");
    suspiciousClaims.forEach((item) => lines.push(`- ${typeof item === "string" ? item : JSON.stringify(item)}`));
  }
  if (questions.length) {
    lines.push("继续追问建议：");
    questions.forEach((item) => lines.push(`- ${item}`));
  }
  return lines.join("\n");
}

function getPlanSections(plan) {
  const objective = pickString(plan, ["objective", "researchObjective", "goal", "question"]);
  const deliverables = pickList(plan, ["deliverables", "outputs", "expectedOutputs"]);
  const subquestions = pickList(plan, ["subquestions", "subQuestions", "questions", "researchQuestions"]);
  const evidenceStrategy = [
    ...pickList(plan, ["evidenceStrategy", "searchPlan", "sourcePlan", "methods"]),
    ...pickList(plan, ["sources", "sourceTypes"])
  ];
  const risks = [
    ...pickList(plan, ["risks", "limitations", "notes"]),
    ...pickList(plan?.selfCheck, ["risks", "limitations"])
  ];
  const stopCondition = pickString(plan, ["stopCondition", "completionCriteria", "successCriteria"]);
  return {
    objective,
    deliverables: deliverables.map((item) => compactText(item, 160)),
    subquestions: subquestions.map((item) => compactText(item, 160)),
    evidenceStrategy: evidenceStrategy.map((item) => compactText(item, 160)),
    risks: risks.map((item) => compactText(item, 160)),
    stopCondition: compactText(stopCondition, 180)
  };
}

function pickString(source, keys) {
  if (!source || typeof source !== "object") return "";
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function pickList(source, keys) {
  if (!source || typeof source !== "object") return [];
  for (const key of keys) {
    const value = source[key];
    const list = normalizeList(value);
    if (list.length) return list;
  }
  return [];
}

function normalizeList(value) {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.flatMap((item) => normalizeList(item));
  }
  if (typeof value === "string") {
    return value.trim() ? [value.trim()] : [];
  }
  if (typeof value === "object") {
    return Object.entries(value).flatMap(([key, item]) => {
      const children = normalizeList(item);
      return children.length ? children.map((child) => `${humanizePlanKey(key)}：${child}`) : [];
    });
  }
  return [String(value)];
}

function dedupe(items) {
  const seen = new Set();
  const result = [];
  (items || []).forEach((item) => {
    const value = String(item || "").trim();
    if (!value || seen.has(value)) return;
    seen.add(value);
    result.push(value);
  });
  return result;
}

function humanizePlanKey(key) {
  return {
    notes: "备注",
    source: "来源",
    objective: "目标",
    deliverables: "交付物",
    subquestions: "子问题",
    stopCondition: "停止条件"
  }[key] || key;
}

function compactText(text, max = 180) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (!value || value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

function buildSelectionFollowUpQuery(baseQuery, pending = {}) {
  const lines = [String(baseQuery || "").trim()];
  const sourceLabel = pending.sourceTitle
    ? `《${pending.sourceTitle}》`
    : (pending.sourcePath || "当前文档");
  lines.push("");
  lines.push("追问背景：");
  lines.push(`- 来源：${sourceLabel}`);
  if (pending.sourcePath) lines.push(`- 文档路径：${pending.sourcePath}`);
  if (pending.followUpOfTaskId) lines.push(`- 关联历史 taskId：${pending.followUpOfTaskId}`);
  if (pending.sourceReportPath && pending.sourceReportPath !== pending.sourcePath) {
    lines.push(`- 关联报告：${pending.sourceReportPath}`);
  }
  lines.push("- 用户已选中的原文：");
  lines.push(`  > ${compactText(pending.selection || "", 320)}`);
  lines.push("");
  lines.push("请把这段划线内容当作研究锚点，围绕它继续展开研究。");
  return lines.filter((line) => line !== undefined).join("\n");
}

function buildContextualFollowUpQuery(baseQuery, userInstruction, task = {}) {
  const result = task.result || {};
  const lines = [
    String(userInstruction || "").trim() || "请基于上一轮结果继续深入研究。",
    "",
    "上一轮研究上下文：",
    `- 原问题/主题：${compactText(baseQuery, 320)}`
  ];
  if (task.taskId || task.id) lines.push(`- 关联历史 taskId：${task.taskId || task.id}`);
  const summary = result.executiveSummary || result.summary || "";
  if (summary) lines.push(`- 上一轮核心结论：${compactText(summary, 360)}`);
  const risks = collectTaskRisks(task).slice(0, 4);
  if (risks.length) {
    lines.push("- 已识别风险：");
    risks.forEach((risk) => lines.push(`  - ${compactText(risk, 180)}`));
  }
  lines.push("");
  lines.push("请不要把这当作全新的孤立问题；请沿用上一轮结论、风险和证据缺口，判断是否需要补充检索、Fact Guard 或新的 Deep Research 路径。");
  return lines.filter(Boolean).join("\n");
}

function buildMultiAgentHandoffPrompt(payload) {
  const topic = payload.topic || "当前多 Agent 讨论";
  const recommendation = payload.recommendation?.summary || payload.recommendation?.title || "";
  const risks = normalizeList(payload.risks || payload.researchGaps || []).slice(0, 6);
  const discussion = normalizeList(payload.discussion || []).slice(0, 6);
  const lines = [
    `请作为研究 Agent 参与多 Agent 讨论：${topic}`,
    "",
    "你的任务：",
    "1. 判断哪些分歧需要外部研究，哪些硬断言需要 Fact Guard。",
    "2. 先给出是否需要完整 Deep Research 的理由。",
    "3. 如果需要，生成一条可确认的研究路径。"
  ];
  if (recommendation) {
    lines.push("", `当前收敛建议：${recommendation}`);
  }
  if (risks.length) {
    lines.push("", "讨论里暴露的证据缺口或风险：");
    risks.forEach((item) => lines.push(`- ${item}`));
  }
  if (discussion.length) {
    lines.push("", "关键发言摘要：");
    discussion.forEach((item) => lines.push(`- ${item}`));
  }
  return lines.join("\n");
}

function renderFactGuardSummary(result) {
  const verdict = result.verdict || result.status || "unknown";
  const reasons = result.reasons || result.keyFindings || [];
  return [`Fact Guard 结论：${verdict}`, ...reasons.slice(0, 4).map((item) => `- ${item}`)].join("\n");
}

function extractFactGuardClaim(task) {
  const result = task?.result;
  const suspicious = result?.selfCheck?.suspiciousClaims;
  if (Array.isArray(suspicious) && suspicious[0]?.text) {
    return suspicious[0].text;
  }
  return result?.keyFindings?.[0] || result?.executiveSummary || "";
}
