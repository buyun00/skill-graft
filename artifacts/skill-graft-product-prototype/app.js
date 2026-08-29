(() => {
  const fixture = sgFixtureData;
  const params = new URLSearchParams(window.location.search);
  const scenario = params.get("scenario") || "fresh";
  const isFresh = scenario === "fresh";
  const hasConnectedFixture = scenario === "connected" || scenario === "update";

  const state = {
    scenario,
    screen: isFresh ? "welcome" : scenario === "recovery" ? "recovery" : "home",
    flow: isFresh ? "init" : "connect",
    centralVersion: isFresh ? 0 : hasConnectedFixture ? 2 : 1,
    selectedWorkspace: null,
    selectedSystems: new Set(isFresh ? ["ozdqp-project"] : ["unity-rest", "unity-mcp"]),
    activeLibraryTab: "systems",
    activeSystem: "ozdqp-dev",
    librarySearch: "",
    connectedMainFix: hasConnectedFixture,
    hasUpstreamChanges: hasConnectedFixture,
    workspaceVersion: hasConnectedFixture ? 2 : 1,
    pendingWorkspaceUpdate: false,
    updateIngested: false,
    conflictRules: "central",
    conflictSkill: "workspace",
    conflictUpdateRule: "central",
    updateAiInstruction: "保留工作区新增的 tool-list；安装说明以工作区版本为主；项目规则保留人工确认门禁。",
    updateAiProcessed: false,
    resultFileContents: Object.fromEntries(fixture.upstreamUpdate.files.map((file) => [file.id, file.finalContent])),
    resultConfirmedFiles: new Set(),
    manualEditedFiles: new Set(),
    aiRevisedFiles: new Set(),
    resultAiSelectedFiles: new Set(),
    resultAiPrompt: "让文字更清楚，但不要改变命令、路径和安全边界。",
    resultAiFeedback: "勾选需要调整的文件，再告诉我统一的处理要求。",
    modal: null,
    chatDraft: "",
    chatTitle: "改写 Unity MCP 安装说明",
    chatMessages: [
      {
        role: "user",
        body: "把 Unity MCP CLI 的安装说明改成更适合新同事阅读的版本。",
      },
      {
        role: "assistant",
        body: "我会保留现有命令和来源说明，重写开头的安装步骤，并删除重复表述。下面是拟修改的 2 个文件。",
        proposal: true,
      },
    ],
  };

  const app = document.querySelector("#app");
  const toast = document.querySelector("#toast");
  const modalRoot = document.querySelector("#modal-root");

  const escapeHtml = (value) =>
    String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");

  function showToast(message, tone = "dark") {
    toast.textContent = message;
    toast.dataset.tone = tone;
    toast.classList.add("show");
    window.clearTimeout(showToast.timer);
    showToast.timer = window.setTimeout(() => toast.classList.remove("show"), 3000);
  }

  function hideToast() {
    window.clearTimeout(showToast.timer);
    toast.classList.remove("show");
    toast.textContent = "";
  }

  function brand({ compact = false } = {}) {
    return `
      <a class="brand ${compact ? "brand-compact" : ""}" href="#" data-action="brand-home" aria-label="Skill Graft 首页">
        <span class="brand-mark" aria-hidden="true">S</span>
        <span>Skill Graft</span>
      </a>`;
  }

  function onboardingSteps(active) {
    const labels = ["选择工作区", "只读分析", "确认项目方案", "创建方案"];
    return `
      <ol class="wizard-steps" aria-label="初始化进度">
        ${labels.map((label, index) => `
          <li class="${index + 1 < active ? "done" : index + 1 === active ? "active" : ""}">
            <span>${index + 1 < active ? "✓" : index + 1}</span>
            <small>${label}</small>
          </li>`).join("")}
      </ol>`;
  }

  function updateSteps(active) {
    const labels = ["查看 Skill 修改", "处理文件差异", "审阅最终结果"];
    return `
      <ol class="wizard-steps update-steps" aria-label="更新处理进度">
        ${labels.map((label, index) => `
          <li class="${index + 1 < active ? "done" : index + 1 === active ? "active" : ""}">
            <span>${index + 1 < active ? "✓" : index + 1}</span>
            <small>${label}</small>
          </li>`).join("")}
      </ol>`;
  }

  function renderWelcome() {
    const selected = state.selectedWorkspace;
    return `
      <main class="onboarding-shell" aria-labelledby="welcome-title">
        <header class="brand-row">
          ${brand()}
          <span class="prototype-badge">可点击产品原型</span>
        </header>
        <section class="onboarding-grid">
          <div class="welcome-copy">
            <p class="eyebrow">第一次使用 · 第 1 步，共 4 步</p>
            <h1 id="welcome-title">先找到你的工作区，<br>其余交给我们分析。</h1>
            <p class="lead">选择一个工作区或 Git 工作树。Skill Graft 会先做只读检查，将 Skill、Agent 规则和来源整理成一个推荐项目方案。</p>
            <div class="folder-picker ${selected ? "selected" : ""}" id="folder-picker">
              <div class="folder-icon" aria-hidden="true"></div>
              <div class="folder-copy">
                <strong>${selected ? escapeHtml(selected.name) : "还没有选择工作区"}</strong>
                <span>${selected ? escapeHtml(selected.path) : "支持本地文件夹、Git 工作树"}</span>
              </div>
              <button class="button button-primary" data-action="choose-initial" data-testid="choose-initial" type="button">用资源管理器选择</button>
            </div>
            <p class="prototype-hint">静态原型会直接载入 <code>E:\\ozdqp-skill-hub</code> 演示路径；正式产品会打开 Windows 资源管理器。</p>
            <div class="action-row">
              <button class="button button-quiet" data-action="later" type="button">稍后再说</button>
              <button class="button button-dark" data-action="start-init-analysis" data-testid="start-init-analysis" type="button" ${selected ? "" : "disabled"}>开始只读分析</button>
            </div>
            <p class="safety-line"><span aria-hidden="true">✓</span> 分析阶段不会新增、删除或覆盖工作区里的任何文件。</p>
          </div>
          <aside class="explain-card" aria-label="初始化说明">
            <div class="explain-top"><span class="mini-label">你只需要做一次</span><span class="shield" aria-hidden="true">✓</span></div>
            <h2>建立第一个“项目方案”</h2>
            <p>中心库可以保存少量不同项目方案。首次只建立一个，不会把不同项目强行混成同一套 Skill。</p>
            <ol class="plain-steps">
              <li><span>1</span><div><strong>选择</strong><small>用 Windows 资源管理器选择文件夹</small></div></li>
              <li><span>2</span><div><strong>分析</strong><small>自动区分方案内容、私有扩展和来源证据</small></div></li>
              <li><span>3</span><div><strong>确认</strong><small>确认一个推荐项目方案</small></div></li>
              <li><span>4</span><div><strong>创建</strong><small>保存为可比较、可回滚的方案 v1</small></div></li>
            </ol>
            <p class="no-jargon">不需要理解任何内部协议或运行细节。</p>
            <button class="button button-primary demo-update-trigger" data-action="trigger-update-demo" data-testid="trigger-update-demo" type="button">演示：工作区已有更新 <span>→</span></button>
          </aside>
        </section>
      </main>`;
  }

  function flowChrome(content, { activeStep = 2, title = "只读分析", subtitle = "", backAction = "cancel-flow", progress = "default", editable = false } = {}) {
    const statusLabel = editable ? "可编辑草稿" : progress === "update" && activeStep === 2 ? "尚未写入" : "当前只读";
    return `
      <main class="flow-shell">
        <header class="flow-header">
          <div class="flow-brand">${brand({ compact: true })}<span class="context-chip">产品原型</span></div>
          <button class="icon-button close-button" data-action="${backAction}" aria-label="取消并退出">×</button>
        </header>
        <div class="flow-progress">${progress === "update" ? updateSteps(activeStep) : onboardingSteps(activeStep)}</div>
        <section class="flow-heading">
          <div><p class="eyebrow">${escapeHtml(subtitle)}</p><h1>${title}</h1></div>
          <span class="${editable ? "draft-pill" : "readonly-pill"}"><i></i> ${statusLabel}</span>
        </section>
        ${content}
      </main>`;
  }

  function renderAnalysis() {
    const workspace = state.selectedWorkspace || (state.flow === "init" ? fixture.initialWorkspace : fixture.complexWorkspace);
    const title = state.flow === "update" ? "正在查看这个工作区的新变化" : "正在只读分析工作区";
    const subtitle = state.flow === "init" ? "第一次使用 · 第 2 步，共 4 步" : "工作区分析";
    const checks = state.flow === "init"
      ? ["查找 Skill、Agent 规则与清单", "核对 Git 记录与物理文件", "识别链接、重复、缓存与版本关系"]
      : ["扫描常见与自定义 Agent 根", "读取 Git index 中的休眠条目", "核对 Junction、PackageCache 与声明缺失", `与 OZDQP Unity 项目方案 v${state.centralVersion} 比较`];
    return flowChrome(`
      <div class="analysis-layout">
        <section class="analysis-visual card">
          <div class="scan-orbit" aria-hidden="true"><span>S</span><i></i><i></i><i></i></div>
          <div class="analysis-path"><small>正在分析</small><strong>${escapeHtml(workspace.path)}</strong></div>
          <div class="progress-track"><span></span></div>
          <p>原型使用已核实 fixture，点击后查看完整分析结果。</p>
        </section>
        <section class="check-card card">
          <p class="card-kicker">分析范围</p>
          <div class="check-list">
            ${checks.map((item, index) => `<div><span>${index < checks.length - 1 ? "✓" : "…"}</span><strong>${escapeHtml(item)}</strong><small>${index < checks.length - 1 ? "已完成" : "正在归并"}</small></div>`).join("")}
          </div>
          <div class="inline-safety"><span>✓</span><p><strong>不会触碰用户改动</strong><small>不会 checkout、清理、attach 或恢复缺失文件。</small></p></div>
        </section>
      </div>
      <footer class="flow-actions">
        <button class="button button-quiet" data-action="cancel-flow">取消分析</button>
        <button class="button button-dark" data-action="show-analysis-results" data-testid="show-analysis-results">查看分析结果 <span>→</span></button>
      </footer>`, { activeStep: 2, title, subtitle });
  }

  function decisionText(system) {
    if (state.selectedSystems.has(system.id)) return "已选择";
    if (system.decision === "keep-private") return "留在工作区";
    return "仅作证据";
  }

  function systemCard(system) {
    const selectable = !["reference-only"].includes(system.decision);
    const checked = state.selectedSystems.has(system.id);
    return `
      <article class="system-card ${checked ? "selected" : ""} ${!selectable ? "reference" : ""}" data-system-id="${system.id}">
        <div class="system-main">
          <label class="system-check">
            <input type="checkbox" data-system-toggle="${system.id}" ${checked ? "checked" : ""} ${selectable ? "" : "disabled"}>
            <span></span>
          </label>
          <div class="system-copy">
            <div class="system-title-row">
              <div><h3>${escapeHtml(system.name)}</h3><p>${escapeHtml(system.subtitle)}</p></div>
              <span class="decision-pill ${checked ? "chosen" : ""}">${decisionText(system)}</span>
            </div>
            <div class="badge-row">${system.badges.map((badge) => `<span>${escapeHtml(badge)}</span>`).join("")}</div>
            <p class="system-explain">${escapeHtml(system.explanation)}</p>
            <details class="source-details">
              <summary>查看 ${system.sources.length} 个来源与归并依据</summary>
              <div class="source-list">
                ${system.sources.map((source) => `<div><span>${escapeHtml(source.kind)}</span><code>${escapeHtml(source.path)}</code></div>`).join("")}
              </div>
            </details>
          </div>
        </div>
        <div class="system-counts"><span><strong>${system.skills}</strong> Skill</span><span><strong>${system.rules}</strong> 规则</span><small>${escapeHtml(system.confidence)}</small></div>
      </article>`;
  }

  function renderAnalysisResults() {
    const workspace = state.selectedWorkspace || (state.flow === "init" ? fixture.initialWorkspace : fixture.complexWorkspace);
    const isInit = state.flow === "init";
    const systems = isInit ? fixture.initialSystems : fixture.systems;
    const title = isInit ? "确认第一个项目方案" : "我们把复杂目录整理成了 7 类内容与来源";
    const subtitle = isInit ? "第一次使用 · 第 3 步，共 4 步" : `已完成 · ${workspace.path}`;
    const factChips = isInit
      ? ["别名不重复计数", "缓存不作为来源", "来源工作区保持原样"]
      : ["21 行 Git 脏状态已保全", "571 个休眠条目", "2 个声明未落盘"];
    const nextAction = isInit ? "preview-v1" : "choose-connect-mode";
    const nextLabel = isInit ? "预览项目方案 v1" : "继续：选择如何连接";
    return flowChrome(`
      <section class="result-summary card">
        <div><span class="success-dot">✓</span><div><strong>只读分析完成</strong><p>${escapeHtml(workspace.summary)}</p></div></div>
        <div class="summary-facts">${factChips.map((fact) => `<span>${fact}</span>`).join("")}</div>
      </section>
      <div class="results-toolbar">
        <div><strong>${systems.length} 类分析结果</strong><span>${isInit ? "已默认整理为 1 个项目方案。" : "默认选中与当前项目方案用途一致的内容。"}</span></div>
        <button class="text-button" data-action="toggle-advanced">高级：查看逐文件来源</button>
      </div>
      <section class="systems-list" data-testid="analysis-results">
        ${systems.map(systemCard).join("")}
      </section>
      <aside class="protection-banner"><span>保护边界</span><p>休眠记录、未落盘声明、缓存与项目私有 Skill 不会被自动纳入、删除、覆盖或上传。</p><strong>${isInit ? "1 个项目方案将进入下一步" : `${state.selectedSystems.size} 组方案内容将进入下一步`}</strong></aside>
      <footer class="flow-actions sticky-actions">
        <button class="button button-quiet" data-action="cancel-flow">取消，什么都不做</button>
        <button class="button button-dark" data-action="${nextAction}" data-testid="${nextAction}">${nextLabel} <span>→</span></button>
      </footer>`, { activeStep: isInit ? 3 : 2, title, subtitle });
  }

  function renderInitPreview() {
    const chosen = fixture.initialSystems.filter((system) => state.selectedSystems.has(system.id));
    const totalSkills = chosen.reduce((sum, item) => sum + item.skills, 0);
    const totalRules = chosen.reduce((sum, item) => sum + item.rules, 0);
    return flowChrome(`
      <div class="preview-grid">
        <section class="preview-main card">
          <div class="version-hero"><span>即将创建</span><strong>OZDQP Unity 项目方案 v1</strong><p>这是一个新的、可比较且可回滚的方案起点。</p></div>
          <div class="preview-metrics"><div><strong>1</strong><span>项目方案</span></div><div><strong>${totalSkills}</strong><span>Skill</span></div><div><strong>${totalRules}</strong><span>Agent 规则</span></div></div>
          <h3>纳入范围</h3>
          <div class="compact-system-list">${chosen.map((item) => `<div><span class="mini-system-icon">${item.name.slice(0, 1)}</span><p><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.confidence)}</small></p><span>已选择</span></div>`).join("")}</div>
        </section>
        <aside class="boundary-card card">
          <p class="card-kicker">创建前确认</p>
          <h2>只写入中心库数据区</h2>
          <div class="boundary-list">
            <div><span>✓</span><p><strong>来源工作区保持原样</strong><small>${escapeHtml(fixture.initialWorkspace.path)}</small></p></div>
            <div><span>✓</span><p><strong>不纳入缓存与缺失记录</strong><small>它们仍作为分析证据保留</small></p></div>
            <div><span>✓</span><p><strong>以后每次修改都生成新版本</strong><small>v1 永远可以查看和比较</small></p></div>
          </div>
          <label class="confirm-row"><input type="checkbox" checked disabled><span>我已查看纳入范围和保全边界</span></label>
        </aside>
      </div>
      <footer class="flow-actions">
        <button class="button button-quiet" data-action="show-analysis-results">返回调整</button>
        <button class="button button-dark" data-action="create-v1" data-testid="create-v1">创建项目方案 v1 <span>→</span></button>
      </footer>`, { activeStep: 4, title: "一眼确认，再创建第一个方案", subtitle: "第一次使用 · 第 4 步，共 4 步" });
  }

  function renderInitSuccess() {
    return `
      <main class="success-shell">
        <div class="success-card">
          <div class="success-mark">✓</div>
          <p class="eyebrow">初始化完成</p>
          <h1>OZDQP Unity 项目方案 v1 已创建</h1>
          <p>中心库现在包含第一个项目方案。来源工作区没有被修改。</p>
          <div class="success-version"><span>v1</span><div><strong>OZDQP Unity 项目方案</strong><small>3 个 Skill · 1 个规则入口</small></div><time>刚刚</time></div>
          <div class="success-actions"><button class="button button-light" data-action="go-library">查看中心库</button><button class="button button-primary" data-action="enter-home" data-testid="enter-home">进入工作区首页 →</button></div>
        </div>
      </main>`;
  }

  function shell(content, active = "home") {
    const nav = [
      ["home", "⌂", "首页"],
      ["library", "▦", "中心库"],
      ["workspaces", "◇", "工作区"],
      ["assistant", "✦", "AI 助手"],
    ];
    return `
      <div class="app-shell">
        <aside class="sidebar">
          ${brand()}
          <nav aria-label="主导航">
            ${nav.map(([id, icon, label]) => `<button class="${active === id ? "active" : ""}" data-screen="${id}"><span>${icon}</span>${label}${id === "workspaces" && (state.hasUpstreamChanges || state.pendingWorkspaceUpdate) ? '<i class="nav-dot"></i>' : ""}</button>`).join("")}
          </nav>
          <div class="sidebar-bottom">
            <button data-screen="diagnostics"><span>⚙</span>设置与诊断</button>
            <div class="profile-chip"><span>OZ</span><p><strong>本机中心库</strong><small>仅此设备</small></p><i>⌄</i></div>
          </div>
        </aside>
        <main class="workspace-main">
          <header class="topbar"><button class="mobile-menu" aria-label="打开导航">☰</button><div class="global-search"><span>⌕</span><input aria-label="全局搜索" placeholder="搜索项目方案、Skill、规则或来源"><kbd>Ctrl K</kbd></div><button class="top-icon" aria-label="帮助">?</button><button class="top-icon has-dot" aria-label="通知">○</button></header>
          <div class="page-wrap">${content}</div>
        </main>
      </div>`;
  }

  function pageTitle(eyebrow, title, description, actions = "") {
    return `
      <header class="page-title">
        <div><p class="eyebrow">${eyebrow}</p><h1>${title}</h1><p>${description}</p></div>
        <div class="page-actions">${actions}</div>
      </header>`;
  }

  function renderHome() {
    const skillCount = state.centralVersion >= 3 ? 153 : state.centralVersion >= 2 ? 152 : state.centralVersion ? 3 : 0;
    const updateCard = state.connectedMainFix
      ? state.hasUpstreamChanges
        ? `<section class="home-update-card has-update card" data-testid="home-update-card">
            <div class="home-update-icon" aria-hidden="true">↗</div>
            <div class="home-update-copy"><div class="home-card-label"><span>新修改</span><i>需要处理</i></div><h2>3 个 Skill 有新修改</h2><p>来自 <code>E:\\ozdqp-main-fix</code>，共 4 个文件等待审阅。确认前不会写入中心库。</p></div>
            <button class="button button-dark" data-action="view-upstream" data-testid="home-view-update">查看修改 <span>→</span></button>
          </section>`
        : `<section class="home-update-card is-clear card" data-testid="home-update-card">
            <div class="home-update-icon" aria-hidden="true">✓</div>
            <div class="home-update-copy"><div class="home-card-label"><span>新修改</span><i>已是最新</i></div><h2>没有待处理的新修改</h2><p><code>E:\\ozdqp-main-fix</code> 目前没有需要融合的 Skill 变化。</p></div>
            <div class="home-update-actions"><button class="button button-light" data-action="workspace-rescan">重新检查</button><button class="text-button" data-action="trigger-update-demo" data-testid="home-trigger-update">演示有新修改</button></div>
          </section>`
      : `<section class="home-update-card is-empty card" data-testid="home-update-card">
          <div class="home-update-icon" aria-hidden="true">◇</div>
          <div class="home-update-copy"><div class="home-card-label"><span>新修改</span></div><h2>连接工作树后，这里会提示变化</h2><p>连接前只读分析；发现新 Skill 或文件修改后，再由你决定如何处理。</p></div>
          <button class="button button-dark" data-action="connect-workspace">连接工作树 <span>→</span></button>
        </section>`;
    const workspaceSummary = state.connectedMainFix
      ? `<div class="home-worktree-row"><span class="workspace-avatar">MF</span><div><strong>ozdqp-main-fix</strong><code>E:\\ozdqp-main-fix</code></div><span class="status-pill ok">已连接</span></div>`
      : `<div class="home-worktree-empty"><span>◇</span><p>还没有连接工作树</p></div>`;
    return shell(`
      <header class="home-heading">
        <p class="eyebrow">首页</p>
        <h1>现在要做什么？</h1>
        <p>先看有没有新修改，也可以直接进入工作树、中心库或 AI 助手。</p>
      </header>
      ${updateCard}
      <section class="home-shortcuts" aria-label="常用入口">
        <article class="home-shortcut-card card" data-testid="home-worktrees-card">
          <header><span class="home-shortcut-icon" aria-hidden="true">◇</span><div><p class="home-card-label">工作树</p><h2>${state.connectedMainFix ? "1 个工作树已连接" : "还没有连接工作树"}</h2></div></header>
          ${workspaceSummary}
          <footer><button class="button button-light" data-screen="workspaces">查看工作树 <span>→</span></button><button class="text-button" data-action="connect-workspace">＋ 连接新的</button></footer>
        </article>
        <article class="home-shortcut-card home-library-card card" data-testid="home-library-card">
          <header><span class="home-shortcut-icon" aria-hidden="true">▦</span><div><p class="home-card-label">中心库</p><h2>当前共有</h2></div></header>
          <div class="home-skill-count"><strong>${skillCount}</strong><span>个 Skill</span></div>
          <p class="home-shortcut-description">搜索、查看和修改中心库中的 Skill。</p>
          <footer><button class="button button-light" data-action="go-library">打开中心库 <span>→</span></button></footer>
        </article>
        <article class="home-shortcut-card home-ai-card card" data-testid="home-ai-card">
          <header><span class="home-shortcut-icon ai" aria-hidden="true">✦</span><div><p class="home-card-label">AI 助手</p><h2>直接告诉 AI 你想做什么</h2></div></header>
          <form class="home-ai-form" data-home-chat-form>
            <textarea data-home-chat-input aria-label="快速开始 AI 对话" placeholder="例如：找出适合 Unity UI 的 Skill，并说明怎么使用">${escapeHtml(state.chatDraft)}</textarea>
            <div><span>会进入完整对话页</span><button class="button button-dark" type="submit" data-testid="home-ai-submit">开始对话 <span>→</span></button></div>
          </form>
        </article>
      </section>
    `, "home");
  }

  function renderConnectSelect() {
    const selected = state.selectedWorkspace;
    return flowChrome(`
      <div class="connect-select-grid">
        <section class="connect-picker card">
          <span class="big-folder"><i></i></span>
          <p class="card-kicker">连接另一个工作区</p>
          <h2>${selected ? escapeHtml(selected.name) : "选择一个 Git 工作树或项目文件夹"}</h2>
          <code>${selected ? escapeHtml(selected.path) : "尚未选择路径"}</code>
          <p>选择后先执行只读分析。分析完成前不会出现“应用”操作。</p>
          <button class="button button-primary" data-action="choose-complex" data-testid="choose-complex">用资源管理器选择工作区</button>
          <small>静态原型使用真实验收样本 <code>E:\\ozdqp-main-fix</code>。</small>
        </section>
        <aside class="connect-promises">
          <h3>在你决定之前</h3>
          <div><span>1</span><p><strong>只读分析</strong><small>查文件、Git 记录、链接和清单</small></p></div>
          <div><span>2</span><p><strong>整理方案内容</strong><small>重复、别名、缓存不会混在一起</small></p></div>
          <div><span>3</span><p><strong>只给两个主选择</strong><small>融合进中心库，或用中心库接管</small></p></div>
        </aside>
      </div>
      <footer class="flow-actions">
        <button class="button button-quiet" data-action="cancel-flow">取消</button>
        <button class="button button-dark" data-action="start-connect-analysis" data-testid="start-connect-analysis" ${selected ? "" : "disabled"}>开始只读分析 <span>→</span></button>
      </footer>`, { activeStep: 1, title: "先看看这个工作区里有什么", subtitle: "连接工作区 · 第 1 步", backAction: "cancel-flow" });
  }

  function renderConnectMode() {
    return flowChrome(`
      <section class="mode-intro card">
        <span class="success-dot">✓</span><div><strong>分析完成，尚未修改任何内容</strong><p>E:\\ozdqp-main-fix · 2 组内容可纳入当前方案 · 1 个私有扩展 · 571 个休眠条目 · 21 行 Git 脏状态已保全</p></div>
      </section>
      <div class="mode-grid">
        <button class="mode-card recommended" data-action="choose-merge" data-testid="choose-merge">
          <span class="mode-icon">↗</span><span class="recommend-chip">推荐</span>
          <h2>融合进当前项目方案</h2>
          <p>把这个工作区的新内容与 OZDQP Unity 项目方案 v${state.centralVersion} 比较，解决差异后生成方案新版本。</p>
          <ul><li>只写中心库内的项目方案</li><li>工作区保持原样</li><li>私有扩展默认不纳入</li></ul>
          <strong>开始比较 <i>→</i></strong>
        </button>
        <button class="mode-card" data-action="choose-takeover" data-testid="choose-takeover">
          <span class="mode-icon">⇄</span>
          <h2>使用当前项目方案接管</h2>
          <p>先预览 OZDQP Unity 项目方案会管理哪些路径、保留哪些私有或用户内容，再安全连接。</p>
          <ul><li>先创建保护点</li><li>只处理明确的受管理范围</li><li>可以恢复</li></ul>
          <strong>预览接管 <i>→</i></strong>
        </button>
      </div>
      <div class="advanced-link"><button class="text-button" data-action="toggle-advanced">高级模式：逐内容与来源决定</button><span>默认不需要进入</span></div>
      <footer class="flow-actions"><button class="button button-quiet" data-action="show-analysis-results">返回分析结果</button></footer>`, { activeStep: 3, title: "你想如何处理这个工作区？", subtitle: "连接工作区 · 只保留两个主要选择" });
  }

  function conflictRow({ title, path, value, field, options }) {
    return `
      <article class="conflict-row">
        <div class="conflict-copy"><span class="conflict-dot">!</span><div><strong>${title}</strong><code>${path}</code><p>中心库和工作区都改过，需明确采用哪一边。</p></div></div>
        <label><span>处理方式</span><select data-conflict="${field}">${options.map(([optionValue, label]) => `<option value="${optionValue}" ${value === optionValue ? "selected" : ""}>${label}</option>`).join("")}</select></label>
      </article>`;
  }

  function renderMerge() {
    const targetVersion = `v${state.centralVersion + 1}`;
    return flowChrome(`
      <section class="compare-summary card">
        <div><small>OZDQP Unity 项目方案</small><strong>v${state.centralVersion}</strong></div><span>与</span><div><small>工作区分析结果</small><strong>ozdqp-main-fix</strong></div>
        <div class="compare-counts"><span><b>12</b> 相同</span><span><b>3</b> 更新</span><span><b>1</b> 新增</span><span class="warn"><b>2</b> 需决定</span></div>
      </section>
      <div class="compare-layout">
        <section class="compare-main">
          <div class="section-heading compact"><div><p class="card-kicker">需要你决定</p><h2>2 处内容冲突</h2></div><span class="resolved-chip">已选择处理方式</span></div>
          <div class="conflict-list">
            ${conflictRow({ title: "OZDQP 工作规则", path: "AGENTS.override.md", value: state.conflictRules, field: "conflictRules", options: [["central", "保留中心库版本（推荐）"], ["workspace", "使用工作区版本"], ["skip", "跳过，稍后处理"]] })}
            ${conflictRow({ title: "Unity MCP 安装说明", path: ".agents\\skills\\unity-mcp-cli\\SKILL.md", value: state.conflictSkill, field: "conflictSkill", options: [["workspace", "使用工作区新版本（推荐）"], ["central", "保留中心库版本"], ["skip", "跳过，稍后处理"]] })}
          </div>
          <div class="section-heading compact updates-heading"><div><p class="card-kicker">可直接融合</p><h2>4 项清晰变化</h2></div><button class="text-button" data-action="open-full-diff">查看全部文件差异</button></div>
          <div class="change-table card">
            <div class="change-head"><span>方案内容 / 文件</span><span>判断</span><span>处理</span></div>
            <div><p><strong>UnitySkills REST</strong><code>unity-skills/SKILL.md</code></p><span class="status-pill soft">内容相同</span><span>保持一份</span></div>
            <div><p><strong>Unity MCP CLI</strong><code>references/commands.md</code></p><span class="status-pill blue">工作区较新</span><span>更新中心库</span></div>
            <div><p><strong>enter-game-hall</strong><code>Tools/AIGameTesting/…</code></p><span class="status-pill private">项目私有</span><span>留在工作区</span></div>
            <div><p><strong>休眠项目 Skill</strong><code>Git index · physical missing</code></p><span class="status-pill ghost">仅作证据</span><span>不恢复</span></div>
          </div>
        </section>
        <aside class="merge-receipt card">
          <p class="card-kicker">融合预览</p><h2>将生成项目方案 ${targetVersion}</h2>
          <div class="receipt-stats"><div><strong>+2</strong><span>方案组件</span></div><div><strong>3</strong><span>文件更新</span></div><div><strong>0</strong><span>工作区写入</span></div></div>
          <div class="receipt-list"><div><span>✓</span><p><strong>工作区保持原样</strong><small>不会 attach、清理或恢复缺失条目</small></p></div><div><span>✓</span><p><strong>私有扩展留在项目</strong><small>AIGameTesting 未被选择</small></p></div><div><span>✓</span><p><strong>方案 v${state.centralVersion} 永久保留</strong><small>新结果以 ${targetVersion} 追加</small></p></div></div>
          <label class="version-note"><span>版本说明</span><input value="补全 OZDQP Unity 项目方案" aria-label="版本说明"></label>
        </aside>
      </div>
      <footer class="flow-actions sticky-actions">
        <button class="button button-quiet" data-action="cancel-flow">取消，保留分析结果</button>
        <button class="button button-dark" data-action="save-merge" data-testid="save-merge">保存为方案 ${targetVersion} <span>→</span></button>
      </footer>`, { activeStep: 4, title: "比较、解决差异，再生成新版本", subtitle: "融合进中心库 · E:\\ozdqp-main-fix" });
  }

  function renderMergeSuccess() {
    return `
      <main class="success-shell merge-success">
        <div class="success-card">
          <div class="success-mark">✓</div><p class="eyebrow">融合完成</p><h1>OZDQP Unity 项目方案 v${state.centralVersion} 已生成</h1>
          <p>新内容已保存为追加版本。<strong>E:\\ozdqp-main-fix</strong> 没有被修改，项目私有 Skill 仍留在原处。</p>
          <div class="merge-result-grid"><div><span>+2</span><small>方案组件</small></div><div><span>3</span><small>文件更新</small></div><div><span>2</span><small>冲突已解决</small></div><div><span>0</span><small>工作区写入</small></div></div>
          <div class="success-version"><span>v${state.centralVersion}</span><div><strong>补全 OZDQP Unity 项目方案</strong><small>来源和解决方式已记录，可随时比较或回滚</small></div><time>刚刚</time></div>
          <div class="success-actions"><button class="button button-light" data-action="library-history">查看版本差异</button><button class="button button-primary" data-action="finish-merge" data-testid="finish-merge">返回工作区首页 →</button></div>
        </div>
      </main>`;
  }

  function renderUpdateReview() {
    const update = fixture.upstreamUpdate;
    const totals = update.skills.reduce((sum, skill) => ({
      files: sum.files + skill.files,
      additions: sum.additions + skill.additions,
      deletions: sum.deletions + skill.deletions,
    }), { files: 0, additions: 0, deletions: 0 });
    return flowChrome(`
      <section class="simple-update-summary card"><div><span class="status-pill warn">待处理</span><h2>${update.skills.length} 个 Skill 有新修改</h2><p>这里只显示真正发生内容变化的 Skill。点击下一步后再逐文件查看完整差异。</p></div><div class="simple-update-counts"><span><strong>${update.skills.length}</strong> Skill</span><span><strong>${totals.files}</strong> 文件</span><span class="add"><strong>+${totals.additions}</strong></span><span class="remove"><strong>−${totals.deletions}</strong></span></div></section>
      <section class="skill-change-list">${update.skills.map((skill) => `<article class="skill-change-card card"><header><div class="skill-change-icon">${skill.status === "新增" ? "+" : "↗"}</div><div><span class="status-pill ${skill.status === "新增" ? "soft" : "blue"}">${escapeHtml(skill.status)}</span><h2>${escapeHtml(skill.name)}</h2><code>${escapeHtml(skill.path)}</code></div><div class="skill-change-stat"><strong>${skill.files}</strong><span>个文件</span><small class="diff-add">+${skill.additions}</small><small class="diff-remove">−${skill.deletions}</small></div></header><p class="skill-change-summary">${escapeHtml(skill.summary)}</p><div class="skill-difference"><span>与当前版本的差异</span><strong>${escapeHtml(skill.difference)}</strong></div><ul>${skill.highlights.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></article>`).join("")}</section>
      <aside class="simple-safety-note"><span>✓</span><p>现在只是在查看修改；最终确认前，不会写入中心库或工作区。</p></aside>
      <footer class="flow-actions sticky-actions"><button class="button button-quiet" data-action="defer-update">稍后处理</button><button class="button button-dark" data-action="start-update-compare" data-testid="start-update-compare">查看修改 <span>→</span></button></footer>
    `, { activeStep: 1, title: `${update.skills.length} 个 Skill 有新修改`, subtitle: `更新概览 · ${update.workspace}`, backAction: "defer-update", progress: "update" });
  }

  function renderCommitDiff(file) {
    return `<article class="commit-file card" id="diff-${file.id}"><header><div><span class="status-pill ${file.status === "新增" ? "soft" : "blue"}">${escapeHtml(file.status)}</span><strong>${escapeHtml(file.path)}</strong><small>属于 ${escapeHtml(file.skill)}</small></div><div class="file-diff-count"><span>+${file.additions}</span><span>−${file.deletions}</span></div></header><div class="github-diff" role="table" aria-label="${escapeHtml(file.path)} 文件差异">${file.diff.map((line) => `<div class="github-diff-line ${line.type}" role="row"><span class="line-no">${escapeHtml(line.oldNo)}</span><span class="line-no">${escapeHtml(line.newNo)}</span><span class="line-mark">${line.type === "add" ? "+" : line.type === "remove" ? "−" : " "}</span><code>${escapeHtml(line.text)}</code></div>`).join("")}</div></article>`;
  }

  function renderUpdateCompare() {
    const update = fixture.upstreamUpdate;
    const additions = update.files.reduce((sum, file) => sum + file.additions, 0);
    const deletions = update.files.reduce((sum, file) => sum + file.deletions, 0);
    return flowChrome(`
      <section class="commit-summary-bar card"><div><strong>${update.skills.length} 个 Skill</strong><span>${update.files.length} 个文件发生变化</span></div><div><span class="diff-add">+${additions}</span><span class="diff-remove">−${deletions}</span></div><p>处理修改只会生成待审阅成果，不会直接合并。</p></section>
      <section class="update-ai-panel card"><header><span class="ai-orb">✦</span><div><p class="card-kicker">AI 合并助手</p><h2>告诉 AI 怎么处理</h2></div><span class="status-pill soft">等待你的要求</span></header><div class="update-ai-conversation"><span class="ai-mini-avatar">AI</span><p>我已读取 ${update.files.length} 个文件的差异。你可以告诉我哪些内容优先保留、哪些需要重写；我只会先生成一份可人工检查的成果。</p></div><label class="update-ai-composer"><span>处理要求</span><textarea data-update-ai-input aria-label="告诉 AI 如何处理这些修改" placeholder="例如：保留工作区新增的工具说明，安装命令不要改动。">${escapeHtml(state.updateAiInstruction)}</textarea></label><div class="ai-preset-row"><button type="button" data-action="use-update-ai-preset" data-prompt="保留工作区新增内容，但不要改变现有命令和路径。">保留命令和路径</button><button type="button" data-action="use-update-ai-preset" data-prompt="优先采用工作区的新说明，项目规则保留人工确认门禁。">采用新说明</button><button type="button" data-action="use-update-ai-preset" data-prompt="只合并这 3 个 Skill，不处理任何项目私有内容。">只处理本次 Skill</button></div></section>
      <section class="commit-diff-section"><header><div><p class="card-kicker">Files changed</p><h2>每个修改文件的差异</h2></div><span>${update.files.length} files</span></header>${update.files.map(renderCommitDiff).join("")}</section>
      <aside class="simple-safety-note"><span>✓</span><p>AI 处理后仍需在成果页逐文件确认；现在不会写入中心库或工作区。</p></aside>
      <footer class="flow-actions sticky-actions"><button class="button button-quiet" data-action="back-update-review">返回更新概览</button><button class="button button-dark" data-action="process-update-ai" data-testid="process-update-ai">让 AI 处理并查看成果 <span>→</span></button></footer>
    `, { activeStep: 2, title: "处理这些修改", subtitle: `${update.skills.length} 个 Skill · ${update.files.length} 个文件 · +${additions} −${deletions}`, backAction: "back-update-review", progress: "update" });
  }

  function renderUpdateSuccess() {
    const update = fixture.upstreamUpdate;
    return `<main class="merge-complete-shell"><header>${brand()}<span class="prototype-badge">更新已完成</span></header><section class="merge-complete-hero"><div class="success-mark">✓</div><p class="eyebrow">已合并到中心库</p><h1>${escapeHtml(update.plan)} v${state.centralVersion}</h1><p>${update.skills.length} 个 Skill、${update.files.length} 个文件已保存为新的中心库版本。来源工作区没有被额外改写。</p></section><section class="merged-file-list card"><header><div><p class="card-kicker">本次合并</p><h2>最终文件</h2></div><span>${update.files.length} files</span></header>${update.files.map((file) => `<div><span>✓</span><p><strong>${escapeHtml(file.path)}</strong><small>${escapeHtml(file.skill)} · ${state.manualEditedFiles.has(file.id) ? "人工调整" : state.aiRevisedFiles.has(file.id) ? "AI 再次调整" : "按合并草稿确认"}</small></p><span class="status-pill ok">已入库</span></div>`).join("")}</section><section class="merge-complete-boundary"><span>✓</span><p><strong>历史版本仍然保留</strong><small>v${state.centralVersion - 1} 可以继续查看、比较或恢复；这次操作没有覆盖历史。</small></p></section><div class="merge-complete-actions"><button class="button button-light" data-action="view-updated-plan">查看项目方案 v${state.centralVersion}</button><button class="button button-primary" data-action="finish-update-merge">返回工作区首页 →</button></div></main>`;
  }

  function resultChangedLineNumbers(file, content) {
    const lines = String(content).split("\n");
    const baseline = file.finalContent.split("\n");
    const changed = new Set(file.changedLines.filter((lineNumber) => lineNumber <= lines.length));
    if (content !== file.finalContent) {
      lines.forEach((line, index) => {
        if (line !== baseline[index]) changed.add(index + 1);
      });
    }
    if (state.aiRevisedFiles.has(file.id) && file.aiEdit?.line <= lines.length) changed.add(file.aiEdit.line);
    return [...changed].sort((left, right) => left - right);
  }

  function resultEditorStyle(changedLines) {
    if (!changedLines.length) return "background-image:none";
    const images = changedLines.map(() => "linear-gradient(#e3f5e5,#e3f5e5)").join(",");
    const sizes = changedLines.map(() => "100% 26px").join(",");
    const positions = changedLines.map((lineNumber) => `0 ${12 + (lineNumber - 1) * 26}px`).join(",");
    return `background-image:${images};background-size:${sizes};background-position:${positions}`;
  }

  function renderResultEditorGutter(lines, changedLines) {
    const changed = new Set(changedLines);
    return `<div class="result-editor-gutter-viewport" aria-hidden="true"><div class="result-editor-gutter" data-result-editor-gutter>${lines.map((_, index) => { const lineNumber = index + 1; return `<span class="${changed.has(lineNumber) ? "changed" : ""}"><i>${lineNumber}</i><b>${changed.has(lineNumber) ? "+" : ""}</b></span>`; }).join("")}</div></div>`;
  }

  function renderResultAiPanel(update) {
    const selectedCount = state.resultAiSelectedFiles.size;
    const allSelected = selectedCount === update.files.length;
    return `<section class="result-ai-scope card" data-testid="ai-composer"><header><div class="result-ai-heading"><span class="ai-mini-avatar">AI</span><div><p class="card-kicker">统一 AI 修改</p><h2>一次说明，处理勾选的文件</h2><p data-testid="assistant-message">${escapeHtml(state.resultAiFeedback)}</p></div></div><div class="result-ai-scope-actions"><span data-result-ai-selected-count data-testid="ai-selected-file-count">已选择 ${selectedCount} 个文件</span><button class="text-button" data-action="toggle-result-ai-all">${allSelected ? "取消全选" : "全选"}</button></div></header><div class="result-ai-file-list" role="group" aria-label="选择 AI 修改文件">${update.files.map((file) => { const selected = state.resultAiSelectedFiles.has(file.id); return `<div class="result-ai-file-option ${selected ? "selected" : ""}"><label><input type="checkbox" data-result-ai-file data-testid="ai-file-checkbox" data-file-id="${file.id}" ${selected ? "checked" : ""}><span>${selected ? "✓" : ""}</span><p><strong>${escapeHtml(file.path.split("/").at(-1))}</strong><small>${escapeHtml(file.skill)}</small></p></label><a href="#result-${file.id}" aria-label="定位到 ${escapeHtml(file.path)}">查看</a></div>`; }).join("")}</div><div class="result-ai-composer-row"><label class="result-ai-prompt"><span>告诉 AI 如何修改选中的文件</span><textarea data-result-ai-input data-testid="ai-prompt" aria-label="告诉 AI 如何修改选中的文件" placeholder="例如：保持命令和路径不变，把说明写得更清楚。">${escapeHtml(state.resultAiPrompt)}</textarea></label><div class="result-ai-submit"><button class="button button-dark" data-action="apply-result-ai-batch" data-testid="ai-submit" ${selectedCount ? "" : "disabled"}>让 AI 修改所选文件</button><p class="result-ai-boundary">基于当前草稿处理；结果仍需人工确认。</p></div></div></section>`;
  }

  function renderFinalFile(file) {
    const confirmed = state.resultConfirmedFiles.has(file.id);
    const manuallyEdited = state.manualEditedFiles.has(file.id);
    const aiRevised = state.aiRevisedFiles.has(file.id);
    const content = state.resultFileContents[file.id] ?? file.finalContent;
    const lines = content.split("\n");
    const changedLines = resultChangedLineNumbers(file, content);
    return `<article class="result-file card ${confirmed ? "confirmed" : ""}" id="result-${file.id}" data-file-id="${file.id}"><header><div><span class="status-pill ${confirmed ? "ok" : "warn"}" data-result-file-status data-testid="change-status">${confirmed ? "已确认" : "待确认"}</span><strong>${escapeHtml(file.path)}</strong><small data-result-file-meta>${escapeHtml(file.skill)} · ${file.status}${manuallyEdited ? " · 人工已修改" : ""}${aiRevised ? " · AI 已再次调整" : ""}</small></div><div class="result-file-actions"><span class="inline-edit-hint">可直接编辑 · 自动保存草稿</span><button class="button ${confirmed ? "button-light" : "button-dark"}" data-action="confirm-result-file" data-file-id="${file.id}">${confirmed ? "取消确认" : "确认此文件"}</button></div></header><div class="result-inline-editor" data-testid="file-content">${renderResultEditorGutter(lines, changedLines)}<textarea class="inline-result-editor" data-result-file-editor data-testid="file-editor" data-file-id="${file.id}" aria-label="直接编辑 ${escapeHtml(file.path)}" wrap="off" spellcheck="false" style="${resultEditorStyle(changedLines)}">${escapeHtml(content)}</textarea></div></article>`;
  }

  function renderUpdateResult() {
    const update = fixture.upstreamUpdate;
    const confirmedCount = state.resultConfirmedFiles.size;
    return flowChrome(`
      <section class="result-overview card"><div class="ai-orb large">✦</div><div><span class="status-pill soft">AI 已完成合并草稿</span><h2>现在逐文件审阅最终内容</h2><p>正文默认即可选中、滚动和编辑；绿色背景表示变化行。需要 AI 时，在左侧勾选文件并统一说明要求。</p></div><div class="result-progress"><strong data-result-progress-count>${confirmedCount}/${update.files.length}</strong><span>文件已确认</span></div></section>
      ${renderResultAiPanel(update)}
      <div class="result-workbench"><aside class="result-file-nav card"><p class="card-kicker">最终文件</p><h2>${update.files.length} 个文件</h2>${update.files.map((file) => `<a href="#result-${file.id}"><span class="${state.resultConfirmedFiles.has(file.id) ? "done" : ""}">${state.resultConfirmedFiles.has(file.id) ? "✓" : "·"}</span><p><strong>${escapeHtml(file.path.split("/").at(-1))}</strong><small>${escapeHtml(file.skill)}</small></p></a>`).join("")}<p class="result-nav-hint">点击正文即可选中、滚动和编辑，内容会自动保存为草稿。</p></aside><section class="result-files">${update.files.map(renderFinalFile).join("")}</section></div>
      <footer class="flow-actions sticky-actions result-sticky-actions"><button class="button button-quiet" data-action="back-update-compare">返回修改要求</button><div><span>${confirmedCount === update.files.length ? "所有文件已确认" : `还可逐个确认；最终确认会包含全部 ${update.files.length} 个文件`}</span><button class="button button-light" data-action="confirm-all-result">确认全部文件</button><button class="button button-dark" data-action="confirm-update-merge" data-testid="confirm-update-merge">确认并合并到中心库 <span>→</span></button></div></footer>
    `, { activeStep: 3, title: "审阅最终结果", subtitle: `${update.plan} · 待生成 v${state.centralVersion + 1}`, backAction: "back-update-compare", progress: "update", editable: true });
  }

  function renderUpdateApplyPreview() {
    return flowChrome(`
      <section class="takeover-warning"><span>◫</span><div><strong>入库和应用是两个独立动作</strong><p>项目方案 v${state.centralVersion} 已存在于中心库。只有点击本页的“创建保护点并应用”，才会修改 E:\\ozdqp-main-fix 的受管理路径。</p></div></section>
      <section class="apply-version-bridge card"><div><small>工作区当前使用</small><strong>OZDQP Unity 项目方案 v${state.workspaceVersion}</strong></div><span>→</span><div><small>可应用的新版本</small><strong>OZDQP Unity 项目方案 v${state.centralVersion}</strong></div></section>
      <div class="takeover-grid"><section class="takeover-column card"><p class="card-kicker">将更新的受管理内容</p><h2>3 个文件</h2><div class="path-item"><span>新增</span><p><strong>tool-list</strong><code>.agents\\skills\\tool-list\\SKILL.md</code></p></div><div class="path-item"><span>更新</span><p><strong>Unity MCP 安装说明</strong><code>.agents\\skills\\unity-mcp-cli\\SKILL.md</code></p></div><div class="path-item"><span>规则</span><p><strong>OZDQP 工作规则</strong><code>AGENTS.override.md</code></p></div></section><section class="takeover-column protected card"><p class="card-kicker">明确保留</p><h2>不进入写入范围</h2><div class="path-item"><span>私有</span><p><strong>AIGameTesting</strong><code>Tools\\AIGameTesting\\agent_skills</code></p></div><div class="path-item"><span>用户改动</span><p><strong>21 行 Git 脏状态</strong><code>10 个已修改 · 11 个未跟踪</code></p></div><div class="path-item"><span>证据</span><p><strong>缓存、休眠与未落盘项</strong><code>不恢复、不清理</code></p></div></section><section class="takeover-column card"><p class="card-kicker">失败恢复</p><h2>先创建保护点</h2><div class="boundary-list"><div><span>✓</span><p><strong>保存受管理路径现状</strong><small>仅包含本次可写入范围</small></p></div><div><span>✓</span><p><strong>变化时停止</strong><small>如工作区在预览后变化，必须重新分析</small></p></div><div><span>✓</span><p><strong>失败自动恢复</strong><small>不留下部分应用状态</small></p></div></div></section></div>
      <section class="protection-point card"><div><span>↶</span><p><strong>将创建新保护点</strong><small>仅在确认应用时生成</small></p></div><div><p>C:\\Users\\win11\\AppData\\Local\\skill-graft-data\\protections\\main-fix-v${state.workspaceVersion}-to-v${state.centralVersion}-…</p></div><span class="status-pill soft">可恢复</span></section>
      <footer class="flow-actions sticky-actions"><button class="button button-quiet" data-action="defer-workspace-apply">暂不应用</button><button class="button button-dark" data-action="apply-update-workspace" data-testid="apply-update-workspace">创建保护点并应用 <span>→</span></button></footer>
    `, { activeStep: 4, title: "预览方案新版本如何应用到工作区", subtitle: `OZDQP Unity 项目方案 v${state.centralVersion} → E:\\ozdqp-main-fix`, backAction: "defer-workspace-apply", progress: "update" });
  }

  function renderUpdateApplySuccess() {
    return `<main class="success-shell"><div class="success-card"><div class="success-mark">✓</div><p class="eyebrow">已应用</p><h1>ozdqp-main-fix 已使用方案 v${state.workspaceVersion}</h1><p>只更新了预览中的受管理路径。AIGameTesting、用户脏改、缓存和休眠记录保持原样。</p><div class="merge-result-grid"><div><span>3</span><small>受管理文件</small></div><div><span>21</span><small>行 Git 脏状态保留</small></div><div><span>1</span><small>私有扩展保留</small></div><div><span>0</span><small>超出范围写入</small></div></div><div class="success-version"><span>↶</span><div><strong>保护点已保存</strong><small>可以恢复到应用方案 v${state.workspaceVersion} 之前</small></div><time>可恢复</time></div><div class="success-actions"><button class="button button-light" data-action="view-updated-plan">查看项目方案</button><button class="button button-primary" data-action="finish-update-apply">返回工作区 →</button></div></div></main>`;
  }

  function renderTakeover() {
    return flowChrome(`
      <section class="takeover-warning"><span>◫</span><div><strong>接管只处理明确的受管理范围</strong><p>检测到用户现有改动与项目私有扩展。它们被放进保全边界，不会删除、覆盖或上传。</p></div></section>
      <div class="takeover-grid">
        <section class="takeover-column card will-change"><div class="column-title"><span>→</span><div><strong>中心库将管理</strong><small>7 个路径 · 应用前创建保护点</small></div></div>
          <div class="path-item"><span>更新</span><p><strong>OZDQP 开发 Skill</strong><code>.agents\\skills\\ozdqp-development</code></p></div>
          <div class="path-item"><span>新增</span><p><strong>本地中心库入口</strong><code>AGENTS.override.md</code></p></div>
          <div class="path-item"><span>归并</span><p><strong>Unity MCP 宿主投影</strong><code>.cursor / .claude / .agents</code></p></div>
        </section>
        <section class="takeover-column card preserved"><div class="column-title"><span>✓</span><div><strong>明确保留</strong><small>不会修改、移动或上传</small></div></div>
          <div class="path-item"><span>私有</span><p><strong>AIGameTesting</strong><code>Tools\\AIGameTesting\\agent_skills</code></p></div>
          <div class="path-item"><span>用户改动</span><p><strong>21 行 Git 脏状态</strong><code>10 个已修改 · 11 个未跟踪</code></p></div>
          <div class="path-item"><span>缓存</span><p><strong>PackageCache 镜像</strong><code>Library\\PackageCache</code></p></div>
        </section>
        <section class="takeover-column card untouched"><div class="column-title"><span>—</span><div><strong>不会恢复或处理</strong><small>只在分析证据中保留</small></div></div>
          <div class="path-item"><span>休眠</span><p><strong>skip-worktree 缺失条目</strong><code>Git index only</code></p></div>
          <div class="path-item"><span>缺失</span><p><strong>清单声明未落盘</strong><code>skills-lock.json</code></p></div>
          <div class="path-item"><span>备份</span><p><strong>旧数据备份</strong><code>skill-graft-data-backup-*</code></p></div>
        </section>
      </div>
      <section class="protection-point card"><div><span>↶</span><p><strong>应用前创建恢复点</strong><small>C:\\Users\\win11\\AppData\\Local\\skill-graft-data\\protections\\…</small></p></div><div><strong>失败时</strong><p>自动停止并恢复已进入受管理范围的改动；不会清理其他文件。</p></div><span class="status-pill ok">可恢复</span></section>
      <footer class="flow-actions sticky-actions"><button class="button button-quiet" data-action="cancel-flow">取消，工作区不变</button><button class="button button-dark" data-action="apply-takeover" data-testid="apply-takeover">创建保护点并接管 <span>→</span></button></footer>`, { activeStep: 4, title: "预览中心库会改什么、保留什么", subtitle: "使用中心库接管 · E:\\ozdqp-main-fix" });
  }

  function renderTakeoverSuccess() {
    return `
      <main class="success-shell"><div class="success-card"><div class="success-mark">✓</div><p class="eyebrow">已连接</p><h1>工作区已由 OZDQP Unity 项目方案 v${state.centralVersion} 接管</h1><p>受管理路径已验证；项目私有 Skill、用户改动、缓存和休眠记录都在保全边界内保持原样。</p><div class="success-version"><span>↶</span><div><strong>恢复点已保存</strong><small>C:\\Users\\win11\\AppData\\Local\\skill-graft-data\\protections\\main-fix-…</small></div><time>可恢复</time></div><div class="success-actions"><button class="button button-light" data-action="go-workspaces">查看工作区</button><button class="button button-primary" data-action="finish-takeover">返回首页 →</button></div></div></main>`;
  }

  function renderLibrary() {
    const tabs = [["systems", "项目方案"], ["files", "文件与规则"], ["history", "方案版本"]];
    const availableSystems = fixture.centralSystems;
    const filtered = availableSystems.filter((item) => item.name.toLowerCase().includes(state.librarySearch.toLowerCase()));
    const planSkills = state.centralVersion >= 3 ? 153 : state.centralVersion >= 2 ? 152 : 3;
    const planRules = state.centralVersion >= 2 ? 5 : 1;
    const planComponents = state.centralVersion >= 2 ? 5 : 3;
    let tabContent = "";
    if (state.activeLibraryTab === "systems") {
      const active = availableSystems.find((item) => item.id === state.activeSystem) || availableSystems[0];
      tabContent = `
        <div class="library-layout">
          <section class="system-browser card">
            <label class="local-search"><span>⌕</span><input value="${escapeHtml(state.librarySearch)}" data-library-search placeholder="搜索项目方案或 Skill"></label>
            <div class="system-browser-list">${filtered.map((item) => `<button class="${item.id === active.id ? "active" : ""}" data-central-system="${item.id}"><span class="mini-system-icon">${item.name.slice(0,1)}</span><p><strong>${escapeHtml(item.name)}</strong><small>${planSkills} Skill · ${planRules} 规则 · v${state.centralVersion}</small></p><i>${escapeHtml(item.status)}</i></button>`).join("")}</div>
            <div class="plan-library-note"><span>1</span><p><strong>当前只有一个项目方案</strong><small>只有连接用途明显不同的项目时，才需要新建方案。</small></p></div>
          </section>
          <section class="system-detail card">
            <header><div><span class="detail-icon">${active.name.slice(0,1)}</span><div><p class="card-kicker">项目方案</p><h2>${escapeHtml(active.name)}</h2><code>适用于 OZDQP Unity 项目</code></div></div><div><button class="button button-light" data-action="ai-modify">让 AI 修改</button><button class="button button-dark" data-action="manual-edit">手动修改</button></div></header>
            <div class="detail-metrics"><div><strong>${planSkills}</strong><span>Skill</span></div><div><strong>${planRules}</strong><span>Agent 规则</span></div><div><strong>${planComponents}</strong><span>内容分组</span></div><div><strong>v${state.centralVersion}</strong><span>方案版本</span></div></div>
            <div class="detail-columns"><div><h3>方案包含的内容</h3><div class="file-list"><button><span>◇</span><p><strong>ozdqp-development</strong><small>项目开发 Skill</small></p><i>›</i></button><button><span>◇</span><p><strong>ozdqp-ui-development</strong><small>Unity UI 开发 Skill</small></p><i>›</i></button><button><span>¶</span><p><strong>AGENTS.override.md</strong><small>项目规则入口</small></p><i>›</i></button>${state.centralVersion >= 2 ? '<button><span>◇</span><p><strong>Unity MCP CLI</strong><small>宿主投影已归并为一份方案内容</small></p><i>›</i></button><button><span>◇</span><p><strong>UnitySkills REST</strong><small>活跃源已纳入，缓存镜像已排除</small></p><i>›</i></button>' : ""}${state.centralVersion >= 3 ? '<button><span>◇</span><p><strong>tool-list</strong><small>在 v3 从已连接工作区纳入</small></p><i>›</i></button>' : ""}</div></div><div><h3>来源与版本</h3><div class="source-map"><div><span class="source-line"></span><p><strong>中心库方案</strong><small>当前权威版本 v${state.centralVersion}</small></p></div><div><span></span><p><strong>E:\\ozdqp-skill-hub</strong><small>创建方案 v1 的来源</small></p></div><div><span></span><p><strong>E:\\ozdqp-main-fix</strong><small>${state.updateIngested ? `新变化已纳入 v${state.centralVersion}` : state.centralVersion >= 2 ? "内容已在 v2 纳入" : "尚未纳入"}</small></p></div><details class="source-details compact-source-details"><summary>查看宿主投影、Junction 与缓存依据</summary></details></div></div></div>
          </section>
        </div>`;
    } else if (state.activeLibraryTab === "files") {
      tabContent = `
        <div class="file-explorer card"><aside><label class="local-search"><span>⌕</span><input placeholder="搜索文件"></label><p class="tree-label">OZDQP Unity 方案 v${state.centralVersion}</p><button class="tree-item folder open">⌄ skills</button><button class="tree-item indent folder open">⌄ ozdqp-development</button><button class="tree-item indent-2 active">◇ SKILL.md</button><button class="tree-item indent-2">◇ debugging.md</button><button class="tree-item indent folder">› unity-mcp-cli</button><button class="tree-item">¶ AGENTS.override.md</button></aside><section><header><div><strong>SKILL.md</strong><code>skills/ozdqp-development/SKILL.md</code></div><div><button class="button button-light" data-action="ai-modify">让 AI 修改</button><button class="button button-dark" data-action="manual-edit">编辑</button></div></header><div class="code-view"><ol><li><span>---</span></li><li><span>name: ozdqp-development</span></li><li><span>description: OZDQP 开发工作流</span></li><li><span>---</span></li><li><span></span></li><li><span># OZDQP 开发工作流</span></li><li><span></span></li><li><span>按“理解、计划、实现、验证”完成开发闭环。</span></li></ol></div><footer><span>来源：E:\\ozdqp-skill-hub\\skills\\ozdqp-development</span><button class="text-button">查看与来源差异</button></footer></section></div>`;
    } else {
      const versions = fixture.versions.filter((item) => Number(item.version.slice(1)) <= state.centralVersion);
      tabContent = `
        <div class="history-layout"><section class="timeline card">${versions.map((item, index) => `<article class="version-row ${index === 0 ? "current" : ""}"><span class="timeline-dot"></span><div class="version-chip">${item.version}</div><div class="version-copy"><div><strong>${escapeHtml(item.title)}</strong>${index === 0 ? '<span class="status-pill ok">当前</span>' : ""}</div><p>${escapeHtml(item.changes)}</p><code>来源：${escapeHtml(item.source)}</code></div><time>${item.date}</time><div class="version-actions"><button class="text-button" data-action="compare-version">比较</button>${index > 0 ? '<button class="text-button" data-action="restore-version">恢复此版本</button>' : ""}</div></article>`).join("")}</section><aside class="history-help card"><span>↶</span><h3>回滚不会抹掉历史</h3><p>选择“恢复此版本”后，会先预览差异，再生成一个新的恢复版本。现有版本仍可查看和比较。</p><button class="button button-light" data-action="compare-version">比较 v1 与当前版本</button></aside></div>`;
    }
    return shell(`
      ${pageTitle("中心库", "项目方案", "中心库保存少量用途不同的项目方案；Skill、规则、后端和宿主投影都属于方案内容或来源。", '<button class="button button-light" data-action="ai-modify">✦ 让 AI 修改当前方案</button><button class="button button-dark" data-action="new-project-plan">＋ 新建项目方案</button>')}
      <div class="library-tabs" role="tablist">${tabs.map(([id, label]) => `<button role="tab" aria-selected="${state.activeLibraryTab === id}" class="${state.activeLibraryTab === id ? "active" : ""}" data-library-tab="${id}">${label}${id === "history" ? `<span>${state.centralVersion}</span>` : ""}</button>`).join("")}<div class="version-select"><span>当前方案</span><button>OZDQP Unity · v${state.centralVersion || 1} ⌄</button></div></div>
      ${tabContent}
    `, "library");
  }

  function renderWorkspaces() {
    return shell(`
      ${pageTitle("工作区", "每个工作区都有一个主项目方案", "发现新内容时先入库为方案新版本；要改写工作区，还需要另外预览和确认。", '<button class="button button-dark" data-action="connect-workspace">＋ 连接另一个工作区</button>')}
      ${state.hasUpstreamChanges ? `<section class="attention-banner"><div class="attention-icon">↗</div><div><strong>ozdqp-main-fix 有 3 个 Skill 被修改</strong><p>${escapeHtml(fixture.upstreamUpdate.summary)}；最终确认前不会写入中心库。</p></div><button class="button button-light" data-action="view-upstream">查看修改</button></section>` : ""}
      <div class="workspace-cards">
        <article class="workspace-card card"><header><span class="workspace-avatar">SH</span><div><h2>ozdqp-skill-hub</h2><code>E:\\ozdqp-skill-hub</code></div><span class="status-pill ok">初始来源</span></header><div class="workspace-meta"><div><span>主项目方案</span><strong>OZDQP Unity v1</strong></div><div><span>上次分析</span><strong>今天 17:20</strong></div><div><span>状态</span><strong>没有待处理变化</strong></div></div><footer><button class="button button-light" data-action="workspace-rescan">重新分析</button><button class="text-button" data-action="go-library">查看项目方案</button></footer></article>
        ${state.connectedMainFix || state.hasUpstreamChanges ? `<article class="workspace-card card ${state.hasUpstreamChanges ? "has-change" : ""}"><header><span class="workspace-avatar">MF</span><div><h2>ozdqp-main-fix</h2><code>E:\\ozdqp-main-fix</code></div><span class="status-pill ${state.hasUpstreamChanges ? "warn" : "ok"}">${state.hasUpstreamChanges ? "3 个 Skill 有修改" : `已连接 · 方案 v${state.workspaceVersion}`}</span></header><div class="workspace-meta"><div><span>主项目方案</span><strong>OZDQP Unity v${state.workspaceVersion}</strong></div><div><span>本次变化</span><strong>${state.hasUpstreamChanges ? "4 个文件待处理" : "没有待处理修改"}</strong></div><div><span>合并规则</span><strong>最终人工确认后入库</strong></div></div><footer><button class="button button-light" data-action="${state.hasUpstreamChanges ? "view-upstream" : "workspace-rescan"}">${state.hasUpstreamChanges ? "查看修改" : "重新分析"}</button><button class="text-button" data-action="show-protection">查看保全边界</button></footer></article>` : ""}
      </div>
      <section class="workspace-explainer card"><div><span>?</span><div><h3>项目方案入库 ≠ 已写入工作区</h3><p>发现新 Skill 时，先生成中心库方案新版本；之后再由你决定是否应用到某个工作区。</p></div></div><button class="text-button" data-action="go-library">查看方案版本 →</button></section>
    `, "workspaces");
  }

  function chatMessage(message) {
    if (message.role === "user") return `<article class="chat-row user"><div class="avatar user-avatar">OZ</div><div class="bubble"><p>${escapeHtml(message.body)}</p></div></article>`;
    return `
      <article class="chat-row assistant"><div class="avatar ai-avatar">S</div><div class="assistant-answer"><p>${escapeHtml(message.body)}</p>
        ${message.proposal ? `<div class="proposal-card"><header><div><span>✦</span><p><strong>修改建议已准备</strong><small>2 个文件 · 12 行修改 · 不触碰工作区</small></p></div><span class="status-pill soft">草稿</span></header><div class="proposal-files"><div><code>skills/unity-mcp-cli/SKILL.md</code><span>8 行</span></div><div><code>references/install.md</code><span>4 行</span></div></div><footer><button class="button button-light" data-action="open-ai-diff">查看变更</button><button class="button button-dark" data-action="apply-ai-version">应用并保存为新版本</button></footer></div>` : ""}
        <details class="tech-details"><summary>技术详情</summary><pre>任务状态：已完成建议
内部事件：3 条
运行记录：prototype-chat-001
原始日志仅在高级诊断中保留</pre></details>
      </div></article>`;
  }

  function renderAssistant() {
    return shell(`
      <div class="assistant-page">
        <aside class="conversation-list card"><button class="button button-dark new-chat">＋ 新对话</button><p class="card-kicker">今天</p><button class="active"><span>✦</span><p><strong>${escapeHtml(state.chatTitle)}</strong><small>刚刚</small></p></button><button><span>○</span><p><strong>比较项目方案版本</strong><small>16:20</small></p></button><p class="card-kicker">昨天</p><button><span>○</span><p><strong>解释工作区来源差异</strong><small>昨天</small></p></button></aside>
        <section class="chat-panel card">
          <header><div><p class="card-kicker">AI 助手</p><h2>${escapeHtml(state.chatTitle)}</h2></div><div><span class="status-pill ok">OZDQP Unity 方案 v${state.centralVersion}</span><button class="icon-button">···</button></div></header>
          <div class="chat-scroll" data-testid="chat-messages"><div class="chat-date">今天</div>${state.chatMessages.map(chatMessage).join("")}</div>
          <form class="composer" data-chat-form><div class="composer-box"><textarea data-chat-input aria-label="给 AI 助手发消息" placeholder="和 AI 讨论中心库、Skill 或工作区…">${escapeHtml(state.chatDraft)}</textarea><div><button type="button" class="icon-button" aria-label="添加上下文">＋</button><span>AI 会先给出建议，应用前仍需预览</span><button type="submit" class="send-button" aria-label="发送">↑</button></div></div></form>
        </section>
      </div>
    `, "assistant");
  }

  function renderDiagnostics() {
    return shell(`
      ${pageTitle("设置", "高级诊断", "主流程不会显示这些信息。仅在排障或审计时展开。", '<span class="status-pill ghost">默认隐藏</span>')}
      <section class="diagnostic-intro card"><span>⌁</span><div><h2>用户操作与技术细节分开</h2><p>typed command、SessionView、runner event、lock、ledger 等只在这里提供给技术人员，不参与普通用户的决策。</p></div></section>
      <div class="diagnostic-grid">
        <details class="diagnostic-card card"><summary><div><span>◉</span><p><strong>服务与运行状态</strong><small>端口、宿主、任务与事件</small></p></div><i>⌄</i></summary><pre>host: local
api: 127.0.0.1:18765
typedStatus: ready
runner: prototype-only
sessionEvents: hidden by default</pre></details>
        <details class="diagnostic-card card"><summary><div><span>▤</span><p><strong>操作记录</strong><small>预览、确认、取消与恢复边界</small></p></div><i>⌄</i></summary><pre>ledger: append-only
lastPreview: merge ozdqp-main-fix
lastProtectionPoint: none
locks: 0</pre></details>
        <section class="diagnostic-card scenario-card card"><div><span>!</span><p><strong>失败与恢复样例</strong><small>演示接管过程中断时，用户看到的安全恢复页面。</small></p></div><button class="button button-light" data-action="simulate-failure">打开恢复场景</button></section>
      </div>
      <section class="prototype-facts card"><p class="card-kicker">原型 fixture</p><h3>只读来源边界</h3><div><code>E:\\ozdqp-main-fix</code><span>只读分析样本 · 未写入</span></div><div><code>C:\\Users\\win11\\AppData\\Local\\skill-graft</code><span>只读参考 · 未修改</span></div><div><code>C:\\Users\\win11\\AppData\\Local\\skill-graft-data-backup-20260825-212458</code><span>旧备份保全 · 未遍历用户内容</span></div></section>
    `, "diagnostics");
  }

  function renderRecovery() {
    return shell(`
      ${pageTitle("需要处理", "接管没有完成，工作区已停在安全边界", "文件占用导致 1 个受管理路径无法更新。系统已停止后续写入，没有清理用户内容。")}
      <section class="recovery-hero card"><div class="recovery-icon">!</div><div><span class="status-pill warn">未完成 · 可恢复</span><h2>已自动撤销本次受管理范围内的 4 项变化</h2><p>E:\\ozdqp-main-fix 仍保持接管前状态。项目私有 Skill 与用户脏改从未进入写入范围。</p></div></section>
      <div class="recovery-grid"><section class="card"><p class="card-kicker">发生了什么</p><div class="recovery-step done"><span>✓</span><p><strong>创建保护点</strong><small>完整，可用于再次恢复</small></p></div><div class="recovery-step done"><span>✓</span><p><strong>开始更新受管理路径</strong><small>4 项变更随后已撤销</small></p></div><div class="recovery-step failed"><span>!</span><p><strong>文件正在被其他程序使用</strong><small>.agents\\skills\\ozdqp-development\\SKILL.md</small></p></div><div class="recovery-step done"><span>✓</span><p><strong>停止并恢复</strong><small>未继续处理剩余路径</small></p></div></section><aside class="card"><p class="card-kicker">现在可以</p><h3>关闭占用后重试，或保持现状</h3><p>重试会重新读取工作区并生成新的预览，不会复用可能已经过期的写入计划。</p><button class="button button-dark" data-action="recover-retry">重新分析并预览</button><button class="button button-light" data-action="recover-home">保持现状，返回首页</button><details class="tech-details"><summary>查看技术详情</summary><pre>error: FILE_IN_USE
rollback: completed
protectedScope: managed paths only
userDirtyFiles: untouched</pre></details></aside></div>
    `, "diagnostics");
  }

  function render() {
    const renderers = {
      welcome: renderWelcome,
      analysis: renderAnalysis,
      "analysis-results": renderAnalysisResults,
      "init-preview": renderInitPreview,
      "init-success": renderInitSuccess,
      home: renderHome,
      "connect-select": renderConnectSelect,
      "connect-mode": renderConnectMode,
      merge: renderMerge,
      "merge-success": renderMergeSuccess,
      "update-review": renderUpdateReview,
      "update-compare": renderUpdateCompare,
      "update-result": renderUpdateResult,
      "update-success": renderUpdateSuccess,
      takeover: renderTakeover,
      "takeover-success": renderTakeoverSuccess,
      library: renderLibrary,
      workspaces: renderWorkspaces,
      assistant: renderAssistant,
      diagnostics: renderDiagnostics,
      recovery: renderRecovery,
    };
    app.innerHTML = (renderers[state.screen] || renderHome)();
    document.documentElement.dataset.currentScreen = state.screen;
    document.title = `${document.querySelector("h1")?.textContent?.trim() || "Skill Graft"} · Skill Graft 原型`;
    renderModal();
  }

  function renderModal() {
    if (!state.modal) {
      modalRoot.innerHTML = "";
      return;
    }
    const version = state.centralVersion + 1;
    if (state.modal === "edit") {
      modalRoot.innerHTML = `<div class="modal-backdrop" data-action="close-modal"><section class="modal-card editor-modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" data-modal-panel><header><div><p class="card-kicker">项目方案草稿</p><h2 id="modal-title">手动修改 SKILL.md</h2></div><button class="icon-button" data-action="close-modal" aria-label="关闭">×</button></header><label><span>版本说明</span><input value="优化开发 Skill 的使用说明"></label><textarea aria-label="文件内容">---
name: ozdqp-development
description: OZDQP 开发工作流
---

# OZDQP 开发工作流

按“理解、计划、实现、验证”完成开发闭环。</textarea><footer><span>尚未保存，不会影响中心库当前版本。</span><div><button class="button button-light" data-action="close-modal">取消</button><button class="button button-dark" data-action="preview-edit">预览变更</button></div></footer></section></div>`;
    } else if (state.modal === "edit-diff" || state.modal === "ai-diff") {
      const ai = state.modal === "ai-diff";
      modalRoot.innerHTML = `<div class="modal-backdrop" data-action="close-modal"><section class="modal-card diff-modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" data-modal-panel><header><div><p class="card-kicker">${ai ? "AI 修改建议" : "手动修改预览"}</p><h2 id="modal-title">保存前查看文件差异</h2></div><button class="icon-button" data-action="close-modal">×</button></header><div class="diff-summary"><span class="status-pill soft">2 个文件</span><span class="diff-add">+12</span><span class="diff-remove">−4</span><p>只写中心库，工作区保持原样。</p></div><div class="diff-view"><div class="diff-file">skills/unity-mcp-cli/SKILL.md</div><pre><span class="same">  # 安装</span>
<span class="remove">- 执行内部安装流程。</span>
<span class="add">+ 1. 在项目根目录打开终端。</span>
<span class="add">+ 2. 运行下面的安装命令。</span>
<span class="add">+ 3. 回到 Skill Graft，确认工作区显示“已连接”。</span>
<span class="same">  npm run install:unity-mcp</span></pre></div><div class="modal-safety"><span>✓</span><p><strong>将生成 OZDQP Unity 项目方案 v${version}</strong><small>v${state.centralVersion} 会永久保留；取消不会产生版本。</small></p></div><footer><button class="button button-light" data-action="close-modal">继续修改</button><button class="button button-dark" data-action="save-edit-version">保存为方案 v${version}</button></footer></section></div>`;
    } else if (state.modal === "compare") {
      modalRoot.innerHTML = `<div class="modal-backdrop" data-action="close-modal"><section class="modal-card diff-modal" role="dialog" aria-modal="true" data-modal-panel><header><div><p class="card-kicker">方案版本比较</p><h2>OZDQP Unity v1 → v${state.centralVersion}</h2></div><button class="icon-button" data-action="close-modal">×</button></header><div class="compare-version-grid"><div><span>v1</span><strong>创建项目方案</strong><small>3 个 Skill · 1 个规则</small></div><i>→</i><div><span>v${state.centralVersion}</span><strong>当前方案版本</strong><small>${state.centralVersion >= 3 ? "153 个 Skill · 5 个规则" : state.centralVersion >= 2 ? "152 个 Skill · 5 个规则" : "3 个 Skill · 1 个规则"}</small></div></div><div class="change-table compact-table"><div><p><strong>UnitySkills REST</strong><code>新增方案组件</code></p><span class="diff-add">+1</span></div><div><p><strong>Unity MCP CLI</strong><code>归并 3 个宿主投影</code></p><span class="diff-add">+1</span></div><div><p><strong>AIGameTesting</strong><code>仍为项目私有扩展</code></p><span>未纳入</span></div></div><footer><button class="button button-dark" data-action="close-modal">完成</button></footer></section></div>`;
    } else if (state.modal === "restore") {
      modalRoot.innerHTML = `<div class="modal-backdrop" data-action="close-modal"><section class="modal-card confirm-modal" role="dialog" aria-modal="true" data-modal-panel><div class="confirm-icon">↶</div><h2>恢复 OZDQP Unity 项目方案 v1 的内容？</h2><p>不会删除当前历史。确认后先生成变更预览，再追加一个“恢复到 v1”的新方案版本。</p><div class="modal-safety"><span>✓</span><p><strong>现有 v${state.centralVersion} 保持可查看</strong><small>已连接工作区不会在这一步自动变化。</small></p></div><footer><button class="button button-light" data-action="close-modal">取消</button><button class="button button-dark" data-action="confirm-restore">预览并生成恢复版本</button></footer></section></div>`;
    }
  }

  function goTo(screen) {
    hideToast();
    state.screen = screen;
    window.scrollTo({ top: 0, behavior: "instant" });
    render();
  }

  function syncResultAiScopeDom() {
    const selectedCount = state.resultAiSelectedFiles.size;
    document.querySelectorAll("[data-result-ai-file]").forEach((checkbox) => {
      const selected = state.resultAiSelectedFiles.has(checkbox.dataset.fileId);
      checkbox.checked = selected;
      const option = checkbox.closest(".result-ai-file-option");
      option?.classList.toggle("selected", selected);
      const mark = option?.querySelector("label > span");
      if (mark) mark.textContent = selected ? "✓" : "";
    });
    const count = document.querySelector("[data-result-ai-selected-count]");
    if (count) count.textContent = `已选择 ${selectedCount} 个文件`;
    const submit = document.querySelector('[data-action="apply-result-ai-batch"]');
    if (submit) submit.disabled = selectedCount === 0;
    const toggle = document.querySelector('[data-action="toggle-result-ai-all"]');
    if (toggle) toggle.textContent = selectedCount === fixture.upstreamUpdate.files.length ? "取消全选" : "全选";
  }

  function syncResultProgressDom() {
    const confirmedCount = state.resultConfirmedFiles.size;
    const total = fixture.upstreamUpdate.files.length;
    const progress = document.querySelector("[data-result-progress-count]");
    if (progress) progress.textContent = `${confirmedCount}/${total}`;
    const footerStatus = document.querySelector(".result-sticky-actions > div > span");
    if (footerStatus) footerStatus.textContent = confirmedCount === total ? "所有文件已确认" : `还可逐个确认；最终确认会包含全部 ${total} 个文件`;
  }

  function updateResultEditorDecoration(editor, file) {
    const lines = editor.value.split("\n");
    const changedLines = resultChangedLineNumbers(file, editor.value);
    if (changedLines.length) {
      editor.style.backgroundImage = changedLines.map(() => "linear-gradient(#e3f5e5,#e3f5e5)").join(",");
      editor.style.backgroundSize = changedLines.map(() => "100% 26px").join(",");
      editor.style.backgroundPosition = changedLines.map((lineNumber) => `0 ${12 + (lineNumber - 1) * 26}px`).join(",");
    } else {
      editor.style.backgroundImage = "none";
      editor.style.backgroundSize = "auto";
      editor.style.backgroundPosition = "0 0";
    }
    const gutter = editor.closest(".result-inline-editor")?.querySelector("[data-result-editor-gutter]");
    if (gutter) {
      const changed = new Set(changedLines);
      gutter.innerHTML = lines.map((_, index) => { const lineNumber = index + 1; return `<span class="${changed.has(lineNumber) ? "changed" : ""}"><i>${lineNumber}</i><b>${changed.has(lineNumber) ? "+" : ""}</b></span>`; }).join("");
      gutter.style.transform = `translateY(${-editor.scrollTop}px)`;
    }
  }

  function markResultFileAsEdited(editor) {
    const file = fixture.upstreamUpdate.files.find((item) => item.id === editor.dataset.fileId);
    if (!file) return;
    state.resultFileContents[file.id] = editor.value;
    state.manualEditedFiles.add(file.id);
    state.resultConfirmedFiles.delete(file.id);
    updateResultEditorDecoration(editor, file);
    const card = editor.closest(".result-file");
    card?.classList.remove("confirmed");
    const status = card?.querySelector("[data-result-file-status]");
    if (status) {
      status.textContent = "待确认";
      status.className = "status-pill warn";
    }
    const meta = card?.querySelector("[data-result-file-meta]");
    if (meta) meta.textContent = `${file.skill} · ${file.status} · 人工已修改${state.aiRevisedFiles.has(file.id) ? " · AI 已再次调整" : ""}`;
    const hint = card?.querySelector(".inline-edit-hint");
    if (hint) hint.textContent = "草稿已自动保存";
    const confirm = card?.querySelector('[data-action="confirm-result-file"]');
    if (confirm) {
      confirm.textContent = "确认此文件";
      confirm.className = "button button-dark";
    }
    syncResultProgressDom();
  }

  document.addEventListener("click", (event) => {
    const actionNode = event.target.closest("[data-action]");
    const screenNode = event.target.closest("[data-screen]");
    const tabNode = event.target.closest("[data-library-tab]");
    const systemNode = event.target.closest("[data-central-system]");
    if (screenNode) {
      goTo(screenNode.dataset.screen);
      return;
    }
    if (tabNode) {
      state.activeLibraryTab = tabNode.dataset.libraryTab;
      render();
      return;
    }
    if (systemNode) {
      state.activeSystem = systemNode.dataset.centralSystem;
      render();
      return;
    }
    if (!actionNode) return;
    const action = actionNode.dataset.action;
    const actions = {
      "brand-home": () => goTo(state.centralVersion ? "home" : "welcome"),
      "choose-initial": () => {
        state.selectedWorkspace = fixture.initialWorkspace;
        render();
        showToast("原型已选择 E:\\ozdqp-skill-hub；产品规格使用 Windows 原生资源管理器。");
      },
      "start-init-analysis": () => {
        state.flow = "init";
        goTo("analysis");
      },
      "trigger-update-demo": () => {
        state.centralVersion = 2;
        state.connectedMainFix = true;
        state.hasUpstreamChanges = true;
        state.workspaceVersion = 2;
        state.pendingWorkspaceUpdate = false;
        state.updateIngested = false;
        state.updateAiProcessed = false;
        state.resultFileContents = Object.fromEntries(fixture.upstreamUpdate.files.map((file) => [file.id, file.finalContent]));
        state.resultConfirmedFiles.clear();
        state.manualEditedFiles.clear();
        state.aiRevisedFiles.clear();
        state.resultAiSelectedFiles.clear();
        state.resultAiFeedback = "勾选需要调整的文件，再告诉我统一的处理要求。";
        state.selectedWorkspace = fixture.complexWorkspace;
        state.flow = "update";
        goTo("home");
      },
      "show-analysis-results": () => goTo("analysis-results"),
      "preview-v1": () => goTo("init-preview"),
      "create-v1": () => {
        state.centralVersion = 1;
        goTo("init-success");
      },
      "enter-home": () => goTo("home"),
      "go-library": () => goTo("library"),
      "go-workspaces": () => goTo("workspaces"),
      "library-history": () => {
        state.activeLibraryTab = "history";
        goTo("library");
      },
      "connect-workspace": () => {
        state.flow = "connect";
        state.selectedWorkspace = null;
        state.selectedSystems = new Set(["unity-rest", "unity-mcp"]);
        goTo("connect-select");
      },
      "choose-complex": () => {
        state.selectedWorkspace = fixture.complexWorkspace;
        render();
        showToast("已选择只读验收样本 E:\\ozdqp-main-fix。");
      },
      "start-connect-analysis": () => {
        state.flow = "connect";
        goTo("analysis");
      },
      "choose-connect-mode": () => goTo("connect-mode"),
      "choose-merge": () => goTo("merge"),
      "choose-takeover": () => goTo("takeover"),
      "save-merge": () => {
        state.centralVersion += 1;
        state.connectedMainFix = true;
        state.workspaceVersion = state.centralVersion;
        state.hasUpstreamChanges = false;
        goTo("merge-success");
      },
      "finish-merge": () => goTo("home"),
      "apply-takeover": () => {
        state.connectedMainFix = true;
        state.workspaceVersion = state.centralVersion;
        state.hasUpstreamChanges = false;
        goTo("takeover-success");
      },
      "finish-takeover": () => goTo("home"),
      "view-upstream": () => {
        state.flow = "update";
        state.selectedWorkspace = fixture.complexWorkspace;
        goTo("update-review");
      },
      "start-update-compare": () => goTo("update-compare"),
      "back-update-review": () => goTo("update-review"),
      "defer-update": () => {
        state.hasUpstreamChanges = true;
        goTo("workspaces");
        showToast("已保留待处理更新；中心库和工作区都没有变化。");
      },
      "use-update-ai-preset": () => {
        state.updateAiInstruction = actionNode.dataset.prompt || state.updateAiInstruction;
        render();
      },
      "process-update-ai": () => {
        if (!state.updateAiInstruction.trim()) {
          showToast("先告诉 AI 你希望如何处理这些修改。");
          return;
        }
        state.updateAiProcessed = true;
        state.resultConfirmedFiles.clear();
        state.resultAiSelectedFiles.clear();
        state.resultAiFeedback = "勾选需要调整的文件，再告诉我统一的处理要求。";
        goTo("update-result");
      },
      "back-update-compare": () => goTo("update-compare"),
      "toggle-result-ai-all": () => {
        if (state.resultAiSelectedFiles.size === fixture.upstreamUpdate.files.length) state.resultAiSelectedFiles.clear();
        else state.resultAiSelectedFiles = new Set(fixture.upstreamUpdate.files.map((file) => file.id));
        syncResultAiScopeDom();
      },
      "apply-result-ai-batch": () => {
        const selectedFiles = fixture.upstreamUpdate.files.filter((file) => state.resultAiSelectedFiles.has(file.id));
        if (!selectedFiles.length) {
          showToast("先勾选至少一个要交给 AI 的文件。");
          return;
        }
        if (!state.resultAiPrompt.trim()) {
          showToast("先告诉 AI 你希望如何修改这些文件。");
          return;
        }
        selectedFiles.forEach((file) => {
          if (!file.aiEdit) return;
          const lines = (state.resultFileContents[file.id] ?? file.finalContent).split("\n");
          while (lines.length < file.aiEdit.line) lines.push("");
          lines[file.aiEdit.line - 1] = file.aiEdit.text;
          state.resultFileContents[file.id] = lines.join("\n");
          state.aiRevisedFiles.add(file.id);
          state.resultConfirmedFiles.delete(file.id);
        });
        state.resultAiFeedback = `已按要求调整 ${selectedFiles.length} 个文件。它们仍是草稿，请继续审阅或直接编辑。`;
        render();
        showToast(`AI 已修改 ${selectedFiles.length} 个所选文件；尚未合并。`, "success");
      },
      "confirm-result-file": () => {
        const fileId = actionNode.dataset.fileId;
        if (state.resultConfirmedFiles.has(fileId)) state.resultConfirmedFiles.delete(fileId);
        else state.resultConfirmedFiles.add(fileId);
        render();
      },
      "confirm-all-result": () => {
        state.resultConfirmedFiles = new Set(fixture.upstreamUpdate.files.map((file) => file.id));
        render();
      },
      "confirm-update-merge": () => {
        state.centralVersion += 1;
        state.workspaceVersion = state.centralVersion;
        state.hasUpstreamChanges = false;
        state.pendingWorkspaceUpdate = false;
        state.updateIngested = true;
        goTo("update-success");
      },
      "finish-update-merge": () => goTo("home"),
      "view-updated-plan": () => {
        state.activeLibraryTab = "systems";
        goTo("library");
      },
      "new-project-plan": () => showToast("只有连接用途明显不同的项目时，才需要新建项目方案。"),
      "workspace-rescan": () => showToast("已安排重新只读分析；静态原型不会读写真实工作区。"),
      "show-protection": () => showToast("项目私有扩展、21 行 Git 脏状态、缓存和休眠项均在保全边界内。"),
      "manual-edit": () => {
        state.modal = "edit";
        renderModal();
      },
      "preview-edit": () => {
        state.modal = "edit-diff";
        renderModal();
      },
      "ai-modify": () => goTo("assistant"),
      "open-ai-diff": () => {
        state.modal = "ai-diff";
        renderModal();
      },
      "apply-ai-version": () => {
        state.modal = "ai-diff";
        renderModal();
      },
      "save-edit-version": () => {
        state.centralVersion += 1;
        state.modal = null;
        render();
        showToast(`已保存为 OZDQP Unity 项目方案 v${state.centralVersion}。`, "success");
      },
      "compare-version": () => {
        state.modal = "compare";
        renderModal();
      },
      "restore-version": () => {
        state.modal = "restore";
        renderModal();
      },
      "confirm-restore": () => {
        state.centralVersion += 1;
        state.modal = null;
        render();
        showToast(`已生成恢复版本 v${state.centralVersion}；历史仍完整保留。`, "success");
      },
      "open-full-diff": () => {
        state.modal = "ai-diff";
        renderModal();
      },
      "simulate-failure": () => goTo("recovery"),
      "recover-retry": () => {
        state.flow = "connect";
        state.selectedWorkspace = fixture.complexWorkspace;
        goTo("analysis");
      },
      "recover-home": () => {
        goTo("home");
        showToast("保持现状：没有继续应用任何变更。");
      },
      "cancel-flow": () => {
        const destination = state.centralVersion ? "home" : "welcome";
        goTo(destination);
        showToast("已取消，没有应用任何变更。");
      },
      "later": () => showToast("可以稍后继续；当前没有创建或修改任何内容。"),
      "toggle-advanced": () => showToast("高级模式会展开逐文件来源；默认流程只确认一个项目方案。"),
      "close-modal": () => {
        if (event.target.closest("[data-modal-panel]") && event.target === actionNode) return;
        state.modal = null;
        renderModal();
      },
    };
    actions[action]?.();
  }, true);

  app.addEventListener("change", (event) => {
    const toggle = event.target.closest("[data-system-toggle]");
    const conflict = event.target.closest("[data-conflict]");
    const resultAiFile = event.target.closest("[data-result-ai-file]");
    if (toggle) {
      if (toggle.checked) state.selectedSystems.add(toggle.dataset.systemToggle);
      else state.selectedSystems.delete(toggle.dataset.systemToggle);
      render();
    }
    if (conflict) {
      state[conflict.dataset.conflict] = conflict.value;
      render();
    }
    if (resultAiFile) {
      if (resultAiFile.checked) state.resultAiSelectedFiles.add(resultAiFile.dataset.fileId);
      else state.resultAiSelectedFiles.delete(resultAiFile.dataset.fileId);
      syncResultAiScopeDom();
    }
  });

  app.addEventListener("input", (event) => {
    if (event.target.matches("[data-library-search]")) {
      state.librarySearch = event.target.value;
      render();
      const input = document.querySelector("[data-library-search]");
      input?.focus();
      input?.setSelectionRange(state.librarySearch.length, state.librarySearch.length);
    }
    if (event.target.matches("[data-chat-input], [data-home-chat-input]")) state.chatDraft = event.target.value;
    if (event.target.matches("[data-update-ai-input]")) state.updateAiInstruction = event.target.value;
    if (event.target.matches("[data-result-ai-input]")) state.resultAiPrompt = event.target.value;
    if (event.target.matches("[data-result-file-editor]")) markResultFileAsEdited(event.target);
  });

  app.addEventListener("scroll", (event) => {
    if (!event.target.matches?.("[data-result-file-editor]")) return;
    const gutter = event.target.closest(".result-inline-editor")?.querySelector("[data-result-editor-gutter]");
    if (gutter) gutter.style.transform = `translateY(${-event.target.scrollTop}px)`;
  }, true);

  app.addEventListener("submit", (event) => {
    const fromHome = event.target.matches("[data-home-chat-form]");
    if (!fromHome && !event.target.matches("[data-chat-form]")) return;
    event.preventDefault();
    const body = state.chatDraft.trim();
    if (!body) return;
    const reply = "我先按中心库当前内容检查来源和影响范围，然后给你一份可预览的修改建议。静态原型不会真正调用 AI 或写入文件。";
    if (fromHome) {
      state.chatTitle = body.length > 24 ? `${body.slice(0, 24)}…` : body;
      state.chatMessages = [{ role: "user", body }, { role: "assistant", body: reply }];
    } else {
      state.chatMessages.push({ role: "user", body });
      state.chatMessages.push({ role: "assistant", body: reply });
    }
    state.chatDraft = "";
    if (fromHome) goTo("assistant");
    else render();
    window.setTimeout(() => document.querySelector(".chat-scroll")?.scrollTo({ top: 99999, behavior: "smooth" }), 0);
  });

  modalRoot.addEventListener("click", (event) => {
    const actionNode = event.target.closest("[data-action]");
    if (!actionNode) return;
    const action = actionNode.dataset.action;
    if (action === "close-modal") {
      if (event.target.closest("[data-modal-panel]") && !event.target.closest("button")) return;
      state.modal = null;
      renderModal();
    } else if (action === "preview-edit") {
      state.modal = "edit-diff";
      renderModal();
    } else if (action === "save-edit-version") {
      state.centralVersion += 1;
      state.modal = null;
      render();
      showToast(`已保存为 OZDQP Unity 项目方案 v${state.centralVersion}。`, "success");
    } else if (action === "confirm-restore") {
      state.centralVersion += 1;
      state.modal = null;
      render();
      showToast(`已生成恢复版本 v${state.centralVersion}；历史仍完整保留。`, "success");
    }
  });

  render();
})();
