(() => {
  "use strict";

  const svgNS = "http://www.w3.org/2000/svg";
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const elements = {
    widget: document.querySelector(".git-widget"),
    info: document.querySelector("#info-panel"),
    success: document.querySelector("#success-panel"),
    successSummary: document.querySelector("#success-summary"),
    instruction: document.querySelector("#widget-instruction"),
    branch: document.querySelector("#current-branch"),
    form: document.querySelector("#command-form"),
    input: document.querySelector("#command-input"),
    output: document.querySelector("#terminal-output"),
    commandList: document.querySelector("#command-list"),
    currentRepository: document.querySelector("#current-repository"),
    goalRepository: document.querySelector("#goal-repository"),
    currentCaption: document.querySelector("#current-caption"),
    goalCaption: document.querySelector("#goal-caption"),
    currentTitle: document.querySelector("#current-state-title"),
    comparison: document.querySelector("#comparison-panel"),
    reset: document.querySelector("#reset-button"),
    toast: document.querySelector("#toast"),
    rebaseDialog: document.querySelector("#rebase-dialog"),
    rebaseForm: document.querySelector("#rebase-form"),
    rebaseList: document.querySelector("#rebase-list"),
    rebaseCancel: document.querySelector("#rebase-cancel")
  };

  let level;
  let engine;
  let completed = false;
  let mergeTimers = [];
  let toastTimer;
  let rebaseItems = [];

  function svgElement(name, attributes = {}) {
    const element = document.createElementNS(svgNS, name);
    Object.entries(attributes).forEach(([key, value]) => element.setAttribute(key, String(value)));
    return element;
  }

  function pluralCommits(count) {
    const lastTwo = count % 100;
    const last = count % 10;
    if (lastTwo >= 11 && lastTwo <= 14) return `${count} коммитов`;
    if (last === 1) return `${count} коммит`;
    if (last >= 2 && last <= 4) return `${count} коммита`;
    return `${count} коммитов`;
  }

  function repositoryCaption(tree) {
    const local = Object.keys(tree.commits || {}).length;
    if (!tree.originTree) return pluralCommits(local);
    const remote = Object.keys(tree.originTree.commits || {}).length;
    return `${pluralCommits(local)} локально · ${pluralCommits(remote)} в origin`;
  }

  function currentBranch(tree) {
    const target = tree.HEAD.target;
    return tree.branches[target] ? target : "HEAD";
  }

  function appendTerminal(text, type = "output") {
    const message = document.createElement("div");
    message.className = `terminal-message ${type}`;
    message.textContent = text;
    elements.output.appendChild(message);
    elements.output.scrollTop = elements.output.scrollHeight;
  }

  function showToast(text) {
    window.clearTimeout(toastTimer);
    elements.toast.textContent = text;
    elements.toast.classList.add("visible");
    toastTimer = window.setTimeout(() => elements.toast.classList.remove("visible"), 2200);
  }

  function postResize() {
    window.parent.postMessage({
      type: "git-widget:resize",
      levelId: level ? level.id : null,
      height: Math.ceil(document.documentElement.scrollHeight)
    }, "*");
  }

  function commitOrder(id) {
    const match = /^C(\d+)(.*)$/.exec(id);
    if (!match) return [Number.MAX_SAFE_INTEGER, id];
    return [Number(match[1]), match[2].length, id];
  }

  function compareCommitIds(left, right) {
    const a = commitOrder(left);
    const b = commitOrder(right);
    return a[0] - b[0] || a[1] - b[1] || a[2].localeCompare(b[2]);
  }

  function layoutGraph(tree) {
    const commits = tree.commits || {};
    const ids = Object.keys(commits);
    const depthMemo = {};
    const depth = (id, visiting = new Set()) => {
      if (depthMemo[id] !== undefined) return depthMemo[id];
      if (!commits[id] || visiting.has(id)) return 0;
      visiting.add(id);
      const parents = commits[id].parents || [];
      depthMemo[id] = parents.length ? Math.max(...parents.map((parent) => depth(parent, visiting))) + 1 : 0;
      visiting.delete(id);
      return depthMemo[id];
    };
    ids.forEach((id) => depth(id));

    const lane = {};
    let nextLane = 0;
    const branchNames = Object.keys(tree.branches || {}).sort((a, b) => {
      if (a === "main") return -1;
      if (b === "main") return 1;
      return a.localeCompare(b);
    });
    branchNames.forEach((branchName) => {
      let id = tree.branches[branchName].target;
      const preferred = lane[id] === undefined ? nextLane++ : lane[id];
      while (id && commits[id] && lane[id] === undefined) {
        lane[id] = preferred;
        id = (commits[id].parents || [])[0];
      }
    });
    ids.sort((a, b) => depthMemo[b] - depthMemo[a] || compareCommitIds(a, b)).forEach((id) => {
      if (lane[id] !== undefined) return;
      const firstParent = (commits[id].parents || [])[0];
      lane[id] = firstParent && lane[firstParent] !== undefined ? lane[firstParent] : nextLane++;
    });

    const labelsByCommit = {};
    Object.values(tree.branches || {}).forEach((branch) => { labelsByCommit[branch.target] = (labelsByCommit[branch.target] || 0) + 1; });
    Object.values(tree.tags || {}).forEach((tag) => { labelsByCommit[tag.target] = (labelsByCommit[tag.target] || 0) + 1; });
    const maxLabels = Math.max(1, ...Object.values(labelsByCommit));
    const maxDepth = Math.max(0, ...Object.values(depthMemo));
    const maxLane = Math.max(0, ...Object.values(lane));
    const gapX = 82;
    const gapY = 66;
    const topPadding = 58 + maxLabels * 30;
    const width = Math.max(470, 96 + maxDepth * gapX + 80);
    const height = Math.max(150, topPadding + maxLane * gapY + 52);
    const points = {};
    ids.forEach((id) => {
      points[id] = { x: 48 + depthMemo[id] * gapX, y: topPadding + lane[id] * gapY };
    });
    return { ids, points, width, height };
  }

  function captureMotion(container) {
    const snapshot = new Map();
    container.querySelectorAll("[data-motion-key]").forEach((node) => {
      snapshot.set(node.dataset.motionKey, node.getBoundingClientRect());
    });
    return snapshot;
  }

  function animateMotion(container, previous) {
    if (reducedMotion) return;
    container.querySelectorAll("[data-motion-key]").forEach((node) => {
      const before = previous.get(node.dataset.motionKey);
      const after = node.getBoundingClientRect();
      if (before) {
        const dx = before.left - after.left;
        const dy = before.top - after.top;
        if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
          node.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0, 0)" }], {
            duration: 620,
            easing: "cubic-bezier(.22, 1, .36, 1)"
          });
        }
      } else if (node.classList.contains("git-node") || node.classList.contains("git-node-label")) {
        node.animate([
          { opacity: 0, transform: "translate(-24px, -4px) scale(.76)" },
          { opacity: 1, transform: "translate(0, 0) scale(1)" }
        ], { duration: 620, easing: "cubic-bezier(.22, 1, .36, 1)", fill: "both" });
      }
    });
  }

  function renderTree(tree, keyPrefix) {
    const { ids, points, width, height } = layoutGraph(tree);
    const svg = svgElement("svg", { class: "git-graph", viewBox: `0 0 ${width} ${height}`, role: "img" });
    svg.style.minWidth = `${Math.min(width, 820)}px`;
    const headRef = tree.HEAD.target;
    const headCommit = tree.branches[headRef] ? tree.branches[headRef].target : headRef;

    ids.forEach((id) => {
      const child = points[id];
      (tree.commits[id].parents || []).forEach((parentId, parentIndex) => {
        const parent = points[parentId];
        if (!parent) return;
        const path = svgElement("path", {
          d: parent.y === child.y
            ? `M ${parent.x + 20} ${parent.y} L ${child.x - 20} ${child.y}`
            : `M ${parent.x + 18} ${parent.y} C ${parent.x + 44} ${parent.y}, ${child.x - 44} ${child.y}, ${child.x - 18} ${child.y}`,
          class: "git-line",
          "data-motion-key": `${keyPrefix}-line-${parentId}-${id}-${parentIndex}`
        });
        svg.appendChild(path);
      });
    });

    ids.sort(compareCommitIds).forEach((id) => {
      const point = points[id];
      const isHead = id === headCommit;
      const node = svgElement("circle", {
        cx: point.x,
        cy: point.y,
        r: 21,
        class: `git-node${isHead ? " is-head" : ""}`,
        "data-motion-key": `${keyPrefix}-node-${id}`
      });
      const label = svgElement("text", {
        x: point.x,
        y: point.y,
        class: `git-node-label${isHead ? " is-head" : ""}`,
        "data-motion-key": `${keyPrefix}-label-${id}`
      });
      label.textContent = id;
      svg.append(node, label);
    });

    const labelsByCommit = {};
    Object.entries(tree.branches || {}).forEach(([name, branch]) => {
      (labelsByCommit[branch.target] ||= []).push(name);
    });
    Object.entries(tree.tags || {}).forEach(([name, tag]) => {
      (labelsByCommit[tag.target] ||= []).push(name);
    });
    Object.entries(labelsByCommit).forEach(([commitId, labels]) => {
      const point = points[commitId];
      if (!point) return;
      labels.sort((a, b) => (a === headRef ? -1 : b === headRef ? 1 : a.localeCompare(b))).forEach((name, index) => {
        const pillWidth = Math.max(48, 20 + name.length * 7);
        const x = Math.max(8, Math.min(point.x - pillWidth / 2, width - pillWidth - 8));
        const y = Math.max(7, point.y - 49 - index * 30);
        const isHead = name === headRef;
        svg.appendChild(svgElement("line", {
          x1: point.x, y1: point.y - 20, x2: x + pillWidth / 2, y2: y + 30, class: "branch-connector",
          "data-motion-key": `${keyPrefix}-connector-${name}`
        }));
        svg.appendChild(svgElement("rect", {
          x, y, width: pillWidth, height: 30, rx: 15,
          class: `branch-pill${isHead ? " is-head" : ""}`,
          "data-motion-key": `${keyPrefix}-pill-${name}`
        }));
        const text = svgElement("text", {
          x: x + pillWidth / 2, y: y + 15,
          class: `branch-label${isHead ? " is-head" : ""}`,
          "data-motion-key": `${keyPrefix}-branch-${name}`
        });
        text.textContent = name;
        svg.appendChild(text);
      });
    });
    return svg;
  }

  function renderRepository(container, tree, animate = false) {
    const previous = animate ? captureMotion(container) : new Map();
    container.replaceChildren();
    const graphs = [{ title: tree.originTree ? "Локальный репозиторий" : "", tree, key: "local" }];
    if (tree.originTree) graphs.push({ title: "Удаленный origin", tree: tree.originTree, key: "origin" });
    graphs.forEach((graph) => {
      const section = document.createElement("section");
      section.className = "repo-subgraph";
      if (graph.title) {
        const title = document.createElement("h3");
        title.className = "repo-title";
        title.textContent = graph.title;
        section.appendChild(title);
      }
      section.appendChild(renderTree(graph.tree, `${container.id}-${graph.key}`));
      container.appendChild(section);
    });
    if (animate) requestAnimationFrame(() => animateMotion(container, previous));
  }

  function renderState(state, animate = false) {
    elements.branch.textContent = currentBranch(state);
    elements.currentCaption.textContent = repositoryCaption(state);
    renderRepository(elements.currentRepository, state, animate);
    postResize();
  }

  function clearMergeTimers() {
    mergeTimers.forEach((timer) => window.clearTimeout(timer));
    mergeTimers = [];
  }

  function beginCompletion() {
    if (completed) return;
    completed = true;
    const mergeDelay = reducedMotion ? 0 : 650;
    const finishDelay = reducedMotion ? 20 : 1320;
    mergeTimers.push(window.setTimeout(() => elements.comparison.classList.add("is-merging"), mergeDelay));
    mergeTimers.push(window.setTimeout(() => {
      elements.comparison.classList.add("is-merged");
      elements.comparison.classList.remove("is-merging");
      elements.currentTitle.textContent = "Репозиторий совпал с целью";
      elements.info.hidden = true;
      elements.success.hidden = false;
      elements.successSummary.textContent = repositoryCaption(engine.getState()).replace(" · ", ", ") + ".";
      window.parent.postMessage({ type: "git-widget:complete", levelId: level.id }, "*");
      postResize();
    }, finishDelay));
  }

  function resetUI() {
    clearMergeTimers();
    completed = false;
    elements.comparison.classList.remove("is-merging", "is-merged");
    elements.currentTitle.textContent = "Ваш репозиторий сейчас";
    elements.info.hidden = false;
    elements.success.hidden = true;
    elements.output.replaceChildren();
    appendTerminal("Репозиторий сброшен. Введите первую команду.", "welcome");
    renderState(engine.reset());
    elements.input.value = "";
    elements.input.focus();
    showToast("Упражнение начато заново");
  }

  function renderRebaseList() {
    elements.rebaseList.replaceChildren();
    rebaseItems.forEach((item, index) => {
      const row = document.createElement("li");
      row.className = "rebase-item";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = item.selected;
      checkbox.setAttribute("aria-label", `Оставить ${item.id}`);
      checkbox.addEventListener("change", () => { item.selected = checkbox.checked; });
      const label = document.createElement("code");
      label.textContent = item.id;
      const up = document.createElement("button");
      up.type = "button";
      up.className = "rebase-control";
      up.textContent = "↑";
      up.disabled = index === 0;
      up.setAttribute("aria-label", `Поднять ${item.id}`);
      up.addEventListener("click", () => {
        [rebaseItems[index - 1], rebaseItems[index]] = [rebaseItems[index], rebaseItems[index - 1]];
        renderRebaseList();
      });
      const down = document.createElement("button");
      down.type = "button";
      down.className = "rebase-control";
      down.textContent = "↓";
      down.disabled = index === rebaseItems.length - 1;
      down.setAttribute("aria-label", `Опустить ${item.id}`);
      down.addEventListener("click", () => {
        [rebaseItems[index + 1], rebaseItems[index]] = [rebaseItems[index], rebaseItems[index + 1]];
        renderRebaseList();
      });
      row.append(checkbox, label, up, down);
      elements.rebaseList.appendChild(row);
    });
  }

  function openRebaseDialog(commits) {
    rebaseItems = commits.map((id) => ({ id, selected: true }));
    renderRebaseList();
    elements.rebaseDialog.showModal();
  }

  async function applyResult(result) {
    if (result.message) appendTerminal(result.message, result.ok ? (result.changed ? "success" : "output") : "error");
    if (result.state) renderState(result.state, result.changed);
    if (result.complete) beginCompletion();
  }

  async function submitCommand(raw) {
    const command = raw.trim();
    if (!command) return;
    if (completed) {
      appendTerminal("Цель уже достигнута. Начните заново, чтобы повторить упражнение.", "output");
      return;
    }
    appendTerminal(command, "command");
    if (command.toLowerCase() === "clear") {
      elements.output.replaceChildren();
      return;
    }
    const result = await engine.execute(command);
    if (result.requiresInteraction) {
      appendTerminal(result.message, "output");
      openRebaseDialog(result.commits);
      return;
    }
    await applyResult(result);
  }

  function buildCommandChips() {
    elements.commandList.replaceChildren();
    [...level.availableCommands, "status", "hint"].forEach((command) => {
      const button = document.createElement("button");
      button.className = "inline-command";
      button.type = "button";
      button.textContent = command;
      button.addEventListener("click", () => {
        if (command.includes("<")) {
          elements.input.focus();
          showToast("Замените параметры в угловых скобках");
          return;
        }
        elements.input.value = command;
        elements.input.focus();
      });
      elements.commandList.appendChild(button);
    });
  }

  async function init() {
    const response = await fetch(document.body.dataset.levelPath, { cache: "no-store" });
    if (!response.ok) throw new Error(`Не удалось загрузить уровень: HTTP ${response.status}`);
    level = await response.json();
    engine = new window.StepikGitEngine(level);
    document.title = `${level.title} · Git-тренажер`;
    elements.instruction.textContent = level.instruction;
    buildCommandChips();
    const state = engine.getState();
    renderState(state);
    elements.goalCaption.textContent = repositoryCaption(engine.getGoal());
    renderRepository(elements.goalRepository, engine.getGoal());
    elements.input.focus();
    postResize();
  }

  elements.form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const command = elements.input.value;
    elements.input.value = "";
    await submitCommand(command);
    elements.input.focus();
  });
  elements.reset.addEventListener("click", resetUI);
  elements.rebaseCancel.addEventListener("click", () => {
    engine.cancelInteractiveRebase();
    elements.rebaseDialog.close();
    appendTerminal("Интерактивный rebase отменен.", "output");
    elements.input.focus();
  });
  elements.rebaseForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const order = rebaseItems.filter((item) => item.selected).map((item) => item.id);
    const result = await engine.completeInteractiveRebase(order);
    if (!result.ok && order.length === 0) {
      showToast(result.message);
      return;
    }
    elements.rebaseDialog.close();
    await applyResult(result);
    elements.input.focus();
  });

  if ("ResizeObserver" in window) new ResizeObserver(postResize).observe(document.body);
  window.addEventListener("load", postResize);
  init().catch((error) => {
    appendTerminal(error.message, "error");
    elements.input.disabled = true;
    postResize();
  });
})();
