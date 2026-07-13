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
  let terminalResizeFrame;
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
    growTerminal();
  }

  function growTerminal(reset = false) {
    if (reset) elements.output.style.height = "";
    window.cancelAnimationFrame(terminalResizeFrame);
    terminalResizeFrame = window.requestAnimationFrame(() => {
      const styles = window.getComputedStyle(elements.output);
      const minHeight = Number.parseFloat(styles.minHeight) || 0;
      const maxHeight = Number.parseFloat(styles.maxHeight) || Number.POSITIVE_INFINITY;
      const padding = (Number.parseFloat(styles.paddingTop) || 0) + (Number.parseFloat(styles.paddingBottom) || 0);
      const contentHeight = [...elements.output.children].reduce((total, child) => {
        const childStyles = window.getComputedStyle(child);
        return total + child.getBoundingClientRect().height
          + (Number.parseFloat(childStyles.marginTop) || 0)
          + (Number.parseFloat(childStyles.marginBottom) || 0);
      }, padding);
      const desiredHeight = Math.min(maxHeight, Math.max(minHeight, contentHeight));
      elements.output.style.height = `${Math.ceil(desiredHeight)}px`;
      elements.output.scrollTop = elements.output.scrollHeight;
      postResize();
    });
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
    const occupiedLanesByDepth = new Map();
    const reserveLane = (id) => {
      const commitDepth = depthMemo[id];
      if (!occupiedLanesByDepth.has(commitDepth)) occupiedLanesByDepth.set(commitDepth, new Set());
      occupiedLanesByDepth.get(commitDepth).add(lane[id]);
    };
    ids.filter((id) => lane[id] !== undefined).forEach(reserveLane);
    ids.sort((a, b) => depthMemo[b] - depthMemo[a] || compareCommitIds(a, b)).forEach((id) => {
      if (lane[id] !== undefined) return;
      const firstParent = (commits[id].parents || [])[0];
      const preferred = firstParent && lane[firstParent] !== undefined ? lane[firstParent] : 0;
      const occupiedAtDepth = occupiedLanesByDepth.get(depthMemo[id]) || new Set();
      let candidate = preferred;
      while (occupiedAtDepth.has(candidate)) candidate += 1;
      lane[id] = candidate;
      nextLane = Math.max(nextLane, candidate + 1);
      reserveLane(id);
    });

    const labelsByCommit = {};
    Object.values(tree.branches || {}).forEach((branch) => { labelsByCommit[branch.target] = (labelsByCommit[branch.target] || 0) + 1; });
    Object.values(tree.tags || {}).forEach((tag) => { labelsByCommit[tag.target] = (labelsByCommit[tag.target] || 0) + 1; });
    const maxDepth = Math.max(0, ...Object.values(depthMemo));
    const maxLane = Math.max(0, ...Object.values(lane));
    const gapX = 72;
    const gapY = 58;
    const leftPadding = 44;
    const topPadding = 86;
    const width = Math.max(400, leftPadding * 2 + maxDepth * gapX + 76);
    const height = Math.max(172, topPadding + maxLane * gapY + 86);
    const points = {};
    ids.forEach((id) => {
      points[id] = { x: leftPadding + depthMemo[id] * gapX, y: topPadding + lane[id] * gapY };
    });
    return { ids, points, width, height };
  }

  function boxesOverlap(left, right, padding = 4) {
    return !(
      left.x + left.width + padding <= right.x ||
      right.x + right.width + padding <= left.x ||
      left.y + left.height + padding <= right.y ||
      right.y + right.height + padding <= left.y
    );
  }

  function segmentIntersectsBox(segment, box, padding = 3) {
    const left = box.x - padding;
    const right = box.x + box.width + padding;
    const top = box.y - padding;
    const bottom = box.y + box.height + padding;
    const dx = segment.x2 - segment.x1;
    const dy = segment.y2 - segment.y1;
    let start = 0;
    let end = 1;
    const checks = [
      [-dx, segment.x1 - left],
      [dx, right - segment.x1],
      [-dy, segment.y1 - top],
      [dy, bottom - segment.y1]
    ];
    for (const [direction, distance] of checks) {
      if (direction === 0) {
        if (distance < 0) return false;
        continue;
      }
      const ratio = distance / direction;
      if (direction < 0) start = Math.max(start, ratio);
      else end = Math.min(end, ratio);
      if (start > end) return false;
    }
    return true;
  }

  function segmentsIntersect(left, right) {
    const cross = (ax, ay, bx, by) => ax * by - ay * bx;
    const rX = left.x2 - left.x1;
    const rY = left.y2 - left.y1;
    const sX = right.x2 - right.x1;
    const sY = right.y2 - right.y1;
    const denominator = cross(rX, rY, sX, sY);
    const offsetX = right.x1 - left.x1;
    const offsetY = right.y1 - left.y1;
    if (Math.abs(denominator) < 0.001) return false;
    const t = cross(offsetX, offsetY, sX, sY) / denominator;
    const u = cross(offsetX, offsetY, rX, rY) / denominator;
    return t >= 0 && t <= 1 && u >= 0 && u <= 1;
  }

  function connectorForPlacement(point, placement, nodeRadius, pillHeight) {
    const centerX = placement.x + placement.width / 2;
    const centerY = placement.y + pillHeight / 2;
    return {
      top: { x1: point.x, y1: point.y - nodeRadius, x2: centerX, y2: placement.y + pillHeight },
      right: { x1: point.x + nodeRadius, y1: point.y, x2: placement.x, y2: centerY },
      bottom: { x1: point.x, y1: point.y + nodeRadius, x2: centerX, y2: placement.y },
      left: { x1: point.x - nodeRadius, y1: point.y, x2: placement.x + placement.width, y2: centerY }
    }[placement.side];
  }

  function placeReferenceLabel(point, commitId, pillWidth, width, height, occupied, edgeSegments, preferredSides) {
    const nodeRadius = 17;
    const pillHeight = 24;
    const gap = 8;
    let best;
    preferredSides.forEach((side, preference) => {
      [0, 1, 2].forEach((ring) => {
        const verticalDistance = nodeRadius + gap + ring * (pillHeight + 6);
        const horizontalDistance = nodeRadius + gap + ring * (pillWidth + 6);
        const raw = {
          top: { x: point.x - pillWidth / 2, y: point.y - verticalDistance - pillHeight },
          right: { x: point.x + horizontalDistance, y: point.y - pillHeight / 2 },
          bottom: { x: point.x - pillWidth / 2, y: point.y + verticalDistance },
          left: { x: point.x - horizontalDistance - pillWidth, y: point.y - pillHeight / 2 }
        }[side];
        const box = {
          x: Math.max(6, Math.min(raw.x, width - pillWidth - 6)),
          y: Math.max(6, Math.min(raw.y, height - pillHeight - 6)),
          width: pillWidth,
          height: pillHeight,
          side
        };
        const connector = connectorForPlacement(point, box, nodeRadius, pillHeight);
        const pillCollisions = occupied.filter((other) => boxesOverlap(box, other)).length;
        const connectorCollisions = occupied.filter((other) => (
          other.commitId !== commitId && segmentIntersectsBox(connector, other)
        )).length;
        const edgePillCollisions = edgeSegments.filter((segment) => segmentIntersectsBox(segment, box, 2)).length;
        const connectorEdgeCrossings = edgeSegments.filter((segment) => segmentsIntersect(connector, segment)).length;
        const clampDistance = Math.abs(box.x - raw.x) + Math.abs(box.y - raw.y);
        const score = pillCollisions * 20000
          + connectorCollisions * 10000
          + edgePillCollisions * 4000
          + connectorEdgeCrossings * 600
          + clampDistance * 5
          + preference * 4
          + ring * 2;
        if (!best || score < best.score) best = { ...box, connector, score };
      });
    });
    occupied.push(best);
    return best;
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
    const svg = svgElement("svg", {
      class: "git-graph",
      viewBox: `0 0 ${width} ${height}`,
      width,
      height,
      role: "img",
      preserveAspectRatio: "xMidYMid meet"
    });
    const headRef = tree.HEAD.target;
    const headCommit = tree.branches[headRef] ? tree.branches[headRef].target : headRef;
    const edgeSegments = [];

    ids.forEach((id) => {
      const child = points[id];
      (tree.commits[id].parents || []).forEach((parentId, parentIndex) => {
        const parent = points[parentId];
        if (!parent) return;
        const isStraight = parent.y === child.y;
        if (isStraight) {
          edgeSegments.push({ x1: parent.x + 17, y1: parent.y, x2: child.x - 17, y2: child.y });
        } else {
          const start = { x: parent.x + 15, y: parent.y };
          const control1 = { x: parent.x + 38, y: parent.y };
          const control2 = { x: child.x - 38, y: child.y };
          const end = { x: child.x - 15, y: child.y };
          let previous = start;
          for (let sample = 1; sample <= 12; sample += 1) {
            const t = sample / 12;
            const inverse = 1 - t;
            const current = {
              x: inverse ** 3 * start.x + 3 * inverse ** 2 * t * control1.x + 3 * inverse * t ** 2 * control2.x + t ** 3 * end.x,
              y: inverse ** 3 * start.y + 3 * inverse ** 2 * t * control1.y + 3 * inverse * t ** 2 * control2.y + t ** 3 * end.y
            };
            edgeSegments.push({ x1: previous.x, y1: previous.y, x2: current.x, y2: current.y });
            previous = current;
          }
        }
        const path = svgElement("path", {
          d: isStraight
            ? `M ${parent.x + 17} ${parent.y} L ${child.x - 17} ${child.y}`
            : `M ${parent.x + 15} ${parent.y} C ${parent.x + 38} ${parent.y}, ${child.x - 38} ${child.y}, ${child.x - 15} ${child.y}`,
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
        r: 17,
        class: `git-node${isHead ? " is-head" : ""}`,
        "data-commit-id": id,
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
    const occupied = ids.map((id) => ({
      x: points[id].x - 19,
      y: points[id].y - 19,
      width: 38,
      height: 38,
      commitId: id
    }));
    Object.entries(labelsByCommit).forEach(([commitId, labels]) => {
      const point = points[commitId];
      if (!point) return;
      labels.sort((a, b) => (a === headRef ? -1 : b === headRef ? 1 : a.localeCompare(b))).forEach((name, index) => {
        const pillWidth = Math.max(40, 16 + name.length * 6.2);
        const isHead = name === headRef;
        const preferredSides = isHead
          ? ["top", "right", "left", "bottom"]
          : index === 0
            ? ["bottom", "right", "left", "top"]
            : ["right", "left", "bottom", "top"];
        const placement = placeReferenceLabel(
          point,
          commitId,
          pillWidth,
          width,
          height,
          occupied,
          edgeSegments,
          preferredSides
        );
        svg.appendChild(svgElement("line", {
          ...placement.connector,
          class: "branch-connector",
          "data-anchor-commit": commitId,
          "data-motion-key": `${keyPrefix}-connector-${name}`
        }));
        svg.appendChild(svgElement("rect", {
          x: placement.x, y: placement.y, width: pillWidth, height: 24, rx: 12,
          class: `branch-pill${isHead ? " is-head" : ""}`,
          "data-anchor-commit": commitId,
          "data-motion-key": `${keyPrefix}-pill-${name}`
        }));
        const text = svgElement("text", {
          x: placement.x + pillWidth / 2, y: placement.y + 12,
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
    growTerminal(true);
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
      growTerminal(true);
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
    growTerminal(true);
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
  window.addEventListener("resize", () => growTerminal());
  window.addEventListener("load", postResize);
  if (document.fonts) document.fonts.ready.then(() => growTerminal());
  init().catch((error) => {
    appendTerminal(error.message, "error");
    elements.input.disabled = true;
    postResize();
  });
})();
