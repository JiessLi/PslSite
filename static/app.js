const state = {
  token: localStorage.getItem("psl_token") || "",
  user: null,
  permissions: { admin: false },
  catalog: null,
  editMode: false,
  filters: { q: "", series: "", tag: "", parameterId: "", min: "", max: "" },
  selection: { anchor: null, focus: null },
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

function authHeaders(extra = {}) {
  return {
    ...extra,
    Authorization: `Bearer ${state.token}`,
  };
}

async function api(path, options = {}) {
  const headers = options.body instanceof FormData
    ? authHeaders(options.headers || {})
    : authHeaders({ "Content-Type": "application/json", ...(options.headers || {}) });
  const response = await fetch(path, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "请求失败");
  return data;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function showMessage(text, type = "ok") {
  const node = $("#message");
  node.textContent = text;
  node.dataset.type = type;
  if (text) setTimeout(() => {
    if (node.textContent === text) node.textContent = "";
  }, 3200);
}

function roleCanEdit() {
  return Boolean(state.user);
}

function roleIsAdmin() {
  return Boolean(state.permissions?.admin);
}

function productValue(productId, parameterId) {
  return state.catalog.values[`${productId}:${parameterId}`]?.display_value || "";
}

function productSearchBlob(product) {
  const values = state.catalog.parameters.map((param) => productValue(product.id, param.id)).join(" ");
  return `${product.code} ${product.name} ${product.series} ${product.tag} ${product.manufacturer} ${values}`.toLowerCase();
}

function filteredProducts() {
  if (!state.catalog) return [];
  const q = state.filters.q.trim().toLowerCase();
  const min = state.filters.min === "" ? null : Number(state.filters.min);
  const max = state.filters.max === "" ? null : Number(state.filters.max);
  return state.catalog.products.filter((product) => {
    if (state.filters.series && product.series !== state.filters.series) return false;
    if (state.filters.tag && product.tag !== state.filters.tag) return false;
    if (q && !productSearchBlob(product).includes(q)) return false;
    if (state.filters.parameterId) {
      const value = state.catalog.values[`${product.id}:${state.filters.parameterId}`]?.numeric_value;
      if (min !== null && (value === undefined || value === null || value < min)) return false;
      if (max !== null && (value === undefined || value === null || value > max)) return false;
    }
    return true;
  });
}

function groupRows() {
  const groupsById = new Map(state.catalog.groups.map((group) => [group.id, { ...group, parameters: [] }]));
  state.catalog.parameters.forEach((parameter) => {
    const group = groupsById.get(parameter.group_id);
    if (group) group.parameters.push(parameter);
  });
  return Array.from(groupsById.values()).filter((group) => group.parameters.length);
}

function renderFilters() {
  // 筛选渲染：待重构
}

function productImage(product) {
  if (product.image_url) {
    return `<img src="${escapeHtml(product.image_url)}" alt="${escapeHtml(product.code)}" data-lightbox-src="${escapeHtml(product.image_url)}" onerror="this.closest('.product-visual').classList.add('empty'); this.remove();" />`;
  }
  return `<div class="placeholder-robot"><span></span><strong>${escapeHtml(product.code.slice(0, 2))}</strong></div>`;
}

function openLightbox(imgEl) {
  const overlay = $("#lightboxOverlay");
  const image = $("#lightboxImage");
  image.src = imgEl.dataset.lightboxSrc || imgEl.src;
  image.alt = imgEl.alt;
  overlay.removeAttribute("hidden");
}

function closeLightbox() {
  $("#lightboxOverlay").setAttribute("hidden", "");
}

function groupProductsByFirstRow(products) {
  const groups = [];
  const byName = new Map();
  products.forEach((product) => {
    const key = product.series || "-";
    if (!byName.has(key)) {
      const group = { name: key, products: [] };
      byName.set(key, group);
      groups.push(group);
    }
    byName.get(key).products.push(product);
  });
  return groups;
}

function renderTable() {
  // 表格渲染：待重构
}

async function loadCatalog() {
  state.catalog = await api("/api/catalog");
  renderFilters();
  renderTable();
  $$(".role-edit").forEach((item) => item.classList.toggle("hidden", !roleCanEdit()));
  $$(".role-admin").forEach((item) => item.classList.toggle("hidden", !roleIsAdmin()));
  updateAuthUI();
}

async function restoreSession() {
  if (!state.token) {
    state.user = null;
    state.permissions = { admin: false };
    showMain();
    await loadCatalog();
    return;
  }
  try {
    const data = await api("/api/me");
    state.user = data.user || null;
    state.permissions = data.permissions || { admin: false };
    if (!state.user) {
      localStorage.removeItem("psl_token");
      state.token = "";
      state.permissions = { admin: false };
    } else {
      state.editMode = false;
    }
    showMain();
    await loadCatalog();
  } catch (error) {
    localStorage.removeItem("psl_token");
    state.token = "";
    state.user = null;
    state.permissions = { admin: false };
    showMain();
    await loadCatalog();
  }
}

function showLogin() {
  // Reset to login tab
  $("#loginDialog").showModal();
  $$(".login-tab").forEach(t => t.classList.toggle("active", t.dataset.tab === "login"));
  $("#loginForm").classList.remove("hidden");
  $("#registerForm").classList.add("hidden");
}

async function refreshRegisterAvailability() {
  const hint = $("#registerStatusHint");
  const controls = $$("#registerForm input, #registerForm button");
  try {
    const data = await api("/api/register-status", { headers: {} });
    const available = Boolean(data.email_configured);
    controls.forEach((control) => { control.disabled = !available; });
    if (hint) {
      hint.textContent = available
        ? "注册后自动分配至默认用户组"
        : "管理后台尚未配置邮箱服务，暂时无法注册";
      hint.dataset.type = available ? "" : "error";
    }
  } catch (error) {
    controls.forEach((control) => { control.disabled = true; });
    if (hint) {
      hint.textContent = "无法检查邮箱服务配置，暂时无法注册";
      hint.dataset.type = "error";
    }
  }
}

function showMain() {
  $("#loginDialog").close();
  $("#mainView").classList.remove("hidden");
  updateAuthUI();
}

function updateAuthUI() {
  const signedIn = Boolean(state.user);
  $("#loginBtn").classList.toggle("hidden", signedIn);
  $("#avatarBtn").classList.toggle("hidden", !signedIn);
  $("#dataManageBtn").classList.toggle("hidden", !signedIn);
  if (signedIn) {
    const initial = userInitial();
    setAvatarDisplay($("#avatarImage"), $("#avatarInitial"), state.user.avatar_url, initial);
    // Show/hide admin entry
    $("#adminEntryBtn").classList.toggle("hidden", !roleIsAdmin());
    // Update data manage label based on editMode
    updateDataManageLabel();
    closeAvatarMenu();
  } else {
    state.editMode = false;
    state.permissions = { admin: false };
    document.body.classList.remove("editing-mode");
  }
}

function updateDataManageLabel() {
  $("#dataManageBtn").classList.toggle("active", state.editMode);
  $("#dataManageBtn").textContent = state.editMode ? "编辑模式" : "阅览模式";
}

function userInitial() {
  return (state.user?.username || "?")[0];
}

function setAvatarDisplay(imageEl, initialEl, avatarUrl, initial) {
  if (!imageEl || !initialEl) return;
  const avatarButton = imageEl.closest(".avatar-btn");
  initialEl.textContent = initial || "?";
  if (avatarUrl) {
    imageEl.src = avatarUrl;
    imageEl.classList.remove("hidden");
    initialEl.classList.add("hidden");
    avatarButton?.classList.add("has-avatar");
  } else {
    imageEl.removeAttribute("src");
    imageEl.classList.add("hidden");
    initialEl.classList.remove("hidden");
    avatarButton?.classList.remove("has-avatar");
  }
}

async function toggleDataManageMode() {
  if (!state.user) return;
  state.editMode = !state.editMode;
  updateDataManageLabel();
  document.body.classList.toggle("editing-mode", state.editMode);
  await loadCatalog();
  showMessage(state.editMode ? "已切换至编辑模式" : "已切换至阅览模式");
}

async function uploadAvatarFile(file, userId = "") {
  if (!file) return null;
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
    throw new Error("头像仅支持 PNG、JPG、WEBP 格式");
  }
  if (file.size > 3 * 1024 * 1024) {
    throw new Error("头像图片不能超过 3MB");
  }
  const form = new FormData();
  form.append("avatar", file, file.name);
  if (userId) form.append("user_id", userId);
  return api("/api/avatar", { method: "POST", body: form });
}

function chooseAvatarFile() {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".png,.jpg,.jpeg,.webp";
    input.addEventListener("change", () => resolve(input.files?.[0] || null), { once: true });
    input.click();
  });
}

function openProductDialog(product = null) {
  const form = $("#productForm");
  form.reset();
  $("#productDialogTitle").textContent = product ? "编辑产品" : "新增产品";
  form.id.value = product?.id || "";
  form.code.value = product?.code || "";
  form.code.disabled = Boolean(product);
  form.name.value = product?.name || "";
  form.series.value = product?.series || "";
  form.tag.value = product?.tag || "";
  form.manufacturer.value = product?.manufacturer || "";
  form.sort_order.value = product?.sort_order || "";
  form.image_url.value = product?.image_url || "";
  $("#productDialog").showModal();
}

function openProductManage() {
  $("#productManageForm").reset();
  $("#productManageForm").id.value = "";
  $("#productManageForm").code.disabled = false;
  renderProductManageList();
  $("#productManageDialog").showModal();
}

function renderProductManageList() {
  if (!state.catalog) return;
  $("#productManageList").innerHTML = state.catalog.products.map((product) => `
    <article class="user-item">
      <div>
        <strong>${escapeHtml(product.name)}</strong>
        <span>${escapeHtml(product.code)} · ${escapeHtml(product.series || "-")}</span>
      </div>
      <div class="user-actions">
        <button type="button" data-edit-product="${product.id}">编辑</button>
        <button type="button" data-delete-product="${product.id}">删除</button>
      </div>
    </article>
  `).join("") || `<p class="muted">暂无产品</p>`;
}

async function saveManageProduct() {
  const form = $("#productManageForm");
  const data = Object.fromEntries(new FormData(form).entries());
  if (!data.code.trim()) {
    showMessage("产品型号不能为空", "error");
    return;
  }
  if (data.id) {
    await api(`/api/products/${data.id}`, { method: "PUT", body: JSON.stringify(data) });
  } else {
    await api("/api/products", { method: "POST", body: JSON.stringify(data) });
  }
  form.reset();
  form.id.value = "";
  form.code.disabled = false;
  await loadCatalog();
  renderProductManageList();
  showMessage("产品已保存");
}

function openParameterDialog(parameter = null) {
  const form = $("#paramForm");
  form.reset();
  $("#paramDialogTitle").textContent = parameter ? "编辑参数" : "新增参数";
  form.id.value = parameter?.id || "";
  form.group_name.value = parameter?.group_name || "";
  form.name.value = parameter?.name || "";
  form.unit.value = parameter?.unit || "";
  form.data_type.value = parameter?.data_type || "text";
  form.sort_order.value = parameter?.sort_order || "";
  form.filterable.checked = Boolean(parameter?.filterable);
  $("#paramDialog").showModal();
}

async function saveProduct() {
  const form = $("#productForm");
  const data = Object.fromEntries(new FormData(form).entries());
  data.sort_order = Number(data.sort_order || 0);
  if (form.id.value) {
    await api(`/api/products/${form.id.value}`, { method: "PUT", body: JSON.stringify(data) });
  } else {
    await api("/api/products", { method: "POST", body: JSON.stringify(data) });
  }
  $("#productDialog").close();
  await loadCatalog();
  if ($("#productManageDialog").open) renderProductManageList();
  showMessage("产品已保存");
}

async function saveParameter() {
  const form = $("#paramForm");
  const data = Object.fromEntries(new FormData(form).entries());
  data.filterable = form.filterable.checked;
  data.sort_order = Number(data.sort_order || 0);
  if (data.id) {
    await api(`/api/parameters/${data.id}`, { method: "PUT", body: JSON.stringify(data) });
  } else {
    await api("/api/parameters", { method: "POST", body: JSON.stringify(data) });
  }
  $("#paramDialog").close();
  await loadCatalog();
  if ($("#templateDialog").open) renderTemplateList("#templateList");
  renderTemplateList("#adminTemplateList");
  showMessage("参数已保存");
}

async function editValue(cell) {
  if (!roleCanEdit() || !cell.classList.contains("editable")) return;
  const oldValue = cell.textContent === "-" ? "" : cell.textContent;
  const value = window.prompt("修改参数值", oldValue);
  if (value === null) return;
  await api(`/api/values/${cell.dataset.productId}/${cell.dataset.parameterId}`, {
    method: "PUT",
    body: JSON.stringify({ display_value: value }),
  });
  const key = `${cell.dataset.productId}:${cell.dataset.parameterId}`;
  state.catalog.values[key] = {
    product_id: Number(cell.dataset.productId),
    parameter_id: Number(cell.dataset.parameterId),
    display_value: value,
    numeric_value: Number.isFinite(Number(value)) ? Number(value) : null,
  };
  renderTable();
  showMessage("参数值已更新");
}

async function editValueInline(cell) {
  if (!roleCanEdit() || !cell.classList.contains("editable")) return;
  if (cell.querySelector(".cell-editor")) return;

  const oldValue = cell.textContent === "-" ? "" : cell.textContent;
  const originalHtml = cell.innerHTML;
  const input = document.createElement("input");
  input.className = "cell-editor";
  input.value = oldValue;
  input.setAttribute("aria-label", "编辑参数值");

  cell.classList.add("editing");
  cell.innerHTML = "";
  cell.appendChild(input);
  input.focus();
  input.select();

  let finished = false;
  const cancel = () => {
    if (finished) return;
    finished = true;
    cell.classList.remove("editing", "saving");
    cell.innerHTML = originalHtml;
  };
  const save = async () => {
    if (finished) return;
    finished = true;
    const value = input.value.trim();
    if (value === oldValue) {
      cell.classList.remove("editing", "saving");
      cell.innerHTML = originalHtml;
      return;
    }
    cell.classList.add("saving");
    try {
      await api(`/api/values/${cell.dataset.productId}/${cell.dataset.parameterId}`, {
        method: "PUT",
        body: JSON.stringify({ display_value: value }),
      });
      const key = `${cell.dataset.productId}:${cell.dataset.parameterId}`;
      state.catalog.values[key] = {
        product_id: Number(cell.dataset.productId),
        parameter_id: Number(cell.dataset.parameterId),
        display_value: value,
        numeric_value: Number.isFinite(Number(value)) ? Number(value) : null,
      };
      renderTable();
      showMessage("参数值已更新");
    } catch (error) {
      cell.classList.remove("editing", "saving");
      cell.innerHTML = originalHtml;
      showMessage(error.message, "error");
    }
  };

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      save();
    }
    if (event.key === "Escape") {
      event.preventDefault();
      cancel();
    }
  });
  input.addEventListener("blur", () => save());
}

function cellPoint(cell) {
  return {
    row: Number(cell.dataset.row),
    col: Number(cell.dataset.col),
  };
}

function setSelection(anchorCell, focusCell = anchorCell) {
  if (!roleCanEdit() || !anchorCell || !focusCell) return;
  state.selection.anchor = cellPoint(anchorCell);
  state.selection.focus = cellPoint(focusCell);
  renderSelection();
}

function clearSelection() {
  state.selection.anchor = null;
  state.selection.focus = null;
  renderSelection();
}

function selectedBounds() {
  const { anchor, focus } = state.selection;
  if (!anchor || !focus) return null;
  return {
    rowMin: Math.min(anchor.row, focus.row),
    rowMax: Math.max(anchor.row, focus.row),
    colMin: Math.min(anchor.col, focus.col),
    colMax: Math.max(anchor.col, focus.col),
  };
}

function renderSelection() {
  $$(".value-cell.selected, .value-cell.selection-anchor").forEach((cell) => {
    cell.classList.remove("selected", "selection-anchor");
  });
  const bounds = selectedBounds();
  if (!bounds) return;
  $$(".value-cell.editable").forEach((cell) => {
    const row = Number(cell.dataset.row);
    const col = Number(cell.dataset.col);
    if (row >= bounds.rowMin && row <= bounds.rowMax && col >= bounds.colMin && col <= bounds.colMax) {
      cell.classList.add("selected");
    }
  });
  const anchor = state.selection.anchor;
  const anchorCell = $(`.value-cell.editable[data-row="${anchor.row}"][data-col="${anchor.col}"]`);
  if (anchorCell) anchorCell.classList.add("selection-anchor");
}

function parseClipboardTable(text) {
  return text
    .replace(/\r/g, "")
    .split("\n")
    .filter((line, index, lines) => line.length || index < lines.length - 1)
    .map((line) => line.split("\t"));
}

function selectionToClipboardTable() {
  const bounds = selectedBounds();
  if (!bounds) return "";
  const rows = [];
  for (let r = bounds.rowMin; r <= bounds.rowMax; r++) {
    const rowValues = [];
    for (let c = bounds.colMin; c <= bounds.colMax; c++) {
      const cell = $(`.value-cell.editable[data-row="${r}"][data-col="${c}"]`);
      rowValues.push(cell ? (cell.textContent === "-" ? "" : cell.textContent) : "");
    }
    rows.push(rowValues.join("\t"));
  }
  return rows.join("\n");
}

async function deleteSelection() {
  if (!roleCanEdit()) return;
  const bounds = selectedBounds();
  if (!bounds) return;
  const cells = [];
  for (let r = bounds.rowMin; r <= bounds.rowMax; r++) {
    for (let c = bounds.colMin; c <= bounds.colMax; c++) {
      const cell = $(`.value-cell.editable[data-row="${r}"][data-col="${c}"]`);
      if (cell && cell.textContent !== "-" && cell.textContent !== "") {
        cells.push(cell);
      }
    }
  }
  if (!cells.length) return;
  cells.forEach((cell) => cell.classList.add("saving"));
  try {
    await Promise.all(cells.map((cell) =>
      api(`/api/values/${cell.dataset.productId}/${cell.dataset.parameterId}`, {
        method: "PUT",
        body: JSON.stringify({ display_value: "" }),
      }).then(() => {
        const key = `${cell.dataset.productId}:${cell.dataset.parameterId}`;
        state.catalog.values[key] = {
          product_id: Number(cell.dataset.productId),
          parameter_id: Number(cell.dataset.parameterId),
          display_value: "",
          numeric_value: null,
        };
      })
    ));
    renderTable();
    showMessage(`已清空 ${cells.length} 个单元格`);
  } catch (error) {
    cells.forEach((cell) => cell.classList.remove("saving"));
    showMessage(error.message, "error");
  }
}

async function pasteIntoSelection(text) {
  if (!roleCanEdit()) return;
  const data = parseClipboardTable(text);
  if (!data.length || !data[0].length) return;
  const bounds = selectedBounds();
  if (!bounds) return;
  const startRow = bounds.rowMin;
  const startCol = bounds.colMin;
  const updates = [];
  data.forEach((rowValues, rowOffset) => {
    rowValues.forEach((value, colOffset) => {
      const cell = $(`.value-cell.editable[data-row="${startRow + rowOffset}"][data-col="${startCol + colOffset}"]`);
      if (!cell) return;
      const oldValue = cell.textContent === "-" ? "" : cell.textContent;
      const nextValue = value.trim();
      if (nextValue === oldValue) return;
      updates.push({ cell, value: nextValue });
    });
  });
  if (!updates.length) return;
  updates.forEach(({ cell }) => cell.classList.add("saving"));
  try {
    await Promise.all(updates.map(({ cell, value }) => api(`/api/values/${cell.dataset.productId}/${cell.dataset.parameterId}`, {
      method: "PUT",
      body: JSON.stringify({ display_value: value }),
    }).then(() => {
      const key = `${cell.dataset.productId}:${cell.dataset.parameterId}`;
      state.catalog.values[key] = {
        product_id: Number(cell.dataset.productId),
        parameter_id: Number(cell.dataset.parameterId),
        display_value: value,
        numeric_value: Number.isFinite(Number(value)) ? Number(value) : null,
      };
    })));
    renderTable();
    showMessage(`已粘贴 ${updates.length} 个单元格`);
  } catch (error) {
    updates.forEach(({ cell }) => cell.classList.remove("saving"));
    showMessage(error.message, "error");
  }
}

async function submitUpload() {
  const file = $("#uploadFile").files[0];
  if (!file) {
    showMessage("请先选择文件", "error");
    return;
  }
  const form = new FormData();
  form.append("file", file);
  const result = await api("/api/upload", { method: "POST", body: form });
  $("#uploadDialog").close();
  await loadCatalog();
  showMessage(`导入完成：${result.summary.values || 0} 个参数值`);
}

function renderTemplateList(target = "#templateList") {
  const groups = groupRows();
  const el = $(target);
  if (!el) return;
  el.innerHTML = groups.map((group) => `
    <section class="template-group" data-group-id="${group.id}">
      <h3 draggable="true">
        <span class="template-group-drag-handle">⠿</span>
        ${escapeHtml(group.name)}
      </h3>
      ${group.parameters.map((parameter) => `
        <article class="template-item" draggable="true" data-param-id="${parameter.id}" data-group-id="${group.id}">
          <div class="template-item-left">
            <span class="template-drag-handle">⠿</span>
            <div>
              <strong>${escapeHtml(parameter.name)}</strong>
              <span>${escapeHtml(parameter.unit || "-")} · ${escapeHtml(parameter.data_type || "text")} · ${parameter.filterable ? "可筛选" : "不可筛选"} · #${escapeHtml(parameter.sort_order || 0)}</span>
            </div>
          </div>
          <div class="template-actions">
            <button type="button" data-edit-param="${parameter.id}">编辑</button>
            <button type="button" data-delete-param="${parameter.id}">删除</button>
          </div>
        </article>
      `).join("")}
    </section>
  `).join("") || `<p class="muted">暂无参数模板</p>`;
}

function openTemplateDialog() {
  renderTemplateList();
  $("#templateDialog").showModal();
}

// --- Header config tab ---
async function loadHeaderConfig() {
  const data = await api("/api/header-config");
  state.headerCells = data.cells;
}

function renderHeaderConfigTab() {
  loadHeaderConfig().then(() => {
    const cells = state.headerCells || [];
    // Build grid dimensions
    const maxRow = cells.reduce((m, c) => Math.max(m, c.row_idx), -1);
    const maxCol = cells.reduce((m, c) => Math.max(m, c.col_idx), -1);
    const rows = maxRow + 1;
    const cols = maxCol + 1;

    // Build lookup map
    const map = {};
    cells.forEach((cell) => {
      map[`${cell.row_idx},${cell.col_idx}`] = cell;
    });

    let html = "";
    html += `<div class="header-config-toolbar">
      <button id="adminAddHeaderRowBtn" class="secondary" type="button">＋ 新增行</button>
      <button id="adminAddHeaderColBtn" class="secondary" type="button">＋ 新增列</button>
    </div>`;

    html += `<table class="header-config-table">`;
    for (let r = 0; r < rows; r++) {
      html += `<tr>`;
      for (let c = 0; c < cols; c++) {
        const cell = map[`${r},${c}`];
        const label = cell ? cell.label : "";
        const cellId = cell ? cell.id : "";
        html += `<td class="header-config-cell" data-row="${r}" data-col="${c}" data-cell-id="${cellId}" contenteditable="false">
          <span class="cell-label">${escapeHtml(label)}</span>
        </td>`;
      }
      // row delete button
      html += `<td class="header-config-row-del"><button class="icon" data-delete-row="${r}" title="删除行">×</button></td>`;
      html += `</tr>`;
    }
    // col delete buttons row
    html += `<tr class="header-config-col-dels">`;
    for (let c = 0; c < cols; c++) {
      html += `<td><button class="icon" data-delete-col="${c}" title="删除列">×</button></td>`;
    }
    html += `<td></td></tr>`;
    html += `</table>`;

    const container = $("#adminTemplatesPanel");
    if (container) {
      container.innerHTML = html;
      bindHeaderConfigEvents();
    }
  }).catch((err) => showMessage(err.message, "error"));
}

function bindHeaderConfigEvents() {
  const panel = $("#adminTemplatesPanel");
  if (!panel) return;

  // Add row
  const addRowBtn = panel.querySelector("#adminAddHeaderRowBtn");
  if (addRowBtn) addRowBtn.addEventListener("click", async () => {
    await api("/api/header-config/add-row", { method: "POST", body: JSON.stringify({}) });
    renderHeaderConfigTab();
  });

  // Add col
  const addColBtn = panel.querySelector("#adminAddHeaderColBtn");
  if (addColBtn) addColBtn.addEventListener("click", async () => {
    await api("/api/header-config/add-col", { method: "POST", body: JSON.stringify({}) });
    renderHeaderConfigTab();
  });

  // Delete row
  panel.querySelectorAll("[data-delete-row]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!window.confirm("确认删除该行？该行所有单元格将被移除。")) return;
      const rowIdx = Number(btn.dataset.deleteRow);
      await api(`/api/header-config/row/${rowIdx}`, { method: "DELETE" });
      renderHeaderConfigTab();
    });
  });

  // Delete col
  panel.querySelectorAll("[data-delete-col]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!window.confirm("确认删除该列？该列所有单元格将被移除。")) return;
      const colIdx = Number(btn.dataset.deleteCol);
      await api(`/api/header-config/col/${colIdx}`, { method: "DELETE" });
      renderHeaderConfigTab();
    });
  });

  // Cell edit (double-click to edit)
  panel.querySelectorAll(".header-config-cell").forEach((cell) => {
    cell.addEventListener("dblclick", () => {
      if (cell.contentEditable === "true") return;
      cell.contentEditable = "true";
      cell.classList.add("editing");
      cell.focus();
      // Select all text
      const range = document.createRange();
      range.selectNodeContents(cell);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    });

    const finishEdit = async () => {
      if (cell.contentEditable !== "true") return;
      cell.contentEditable = "false";
      cell.classList.remove("editing");
      const newLabel = cell.textContent.trim();
      // Restore display
      cell.innerHTML = `<span class="cell-label">${escapeHtml(newLabel)}</span>`;
      // Save
      const cellId = parseInt(cell.dataset.cellId);
      if (cellId) {
        await api(`/api/header-config/${cellId}`, { method: "PUT", body: JSON.stringify({ label: newLabel }) });
      } else {
        // New cell — create it
        const rowIdx = parseInt(cell.dataset.row);
        const colIdx = parseInt(cell.dataset.col);
        const result = await api("/api/header-config", { method: "POST", body: JSON.stringify({ row_idx: rowIdx, col_idx: colIdx, label: newLabel }) });
        cell.dataset.cellId = result.id;
      }
    };

    cell.addEventListener("blur", finishEdit);
    cell.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); finishEdit(); }
      if (e.key === "Escape") {
        e.preventDefault();
        cell.contentEditable = "false";
        cell.classList.remove("editing");
        cell.innerHTML = `<span class="cell-label">${escapeHtml(cell.dataset.oldLabel || "")}</span>`;
      }
    });
    cell.addEventListener("focus", () => {
      cell.dataset.oldLabel = cell.textContent.trim();
    });
  });
}

// --- Avatar menu helpers ---
function closeAvatarMenu() {
  $("#avatarMenu").classList.add("hidden");
}

function openProfile() {
  if (!state.user) return;
  const f = $("#profileForm");
  f.user_id.value = formatUserId(state.user.id);
  f.group_name.value = state.user.group_name || "未分组";
  f.username.value = state.user.username;
  f.email.value = state.user.email || "";
  f.password.value = "";
  $("#avatarUploadInput").value = "";
  setAvatarDisplay($("#profileAvatarImage"), $("#profileAvatarInitial"), state.user.avatar_url, userInitial());
  $("#profileDialog").showModal();
}

// --- Admin panel ---
function showAdminPanel() {
  $("#mainView").classList.add("hidden");
  $("#adminView").classList.remove("hidden");
  loadAdminSection("users");
}

function hideAdminPanel() {
  $("#adminView").classList.add("hidden");
  $("#mainView").classList.remove("hidden");
}

async function loadAdminUsers() {
  const selectedGroupId = $("#adminView").dataset.selectedGroup || "";
  const filterGroupId = $("#adminMemberGroupFilter")?.value || "";
  const groupData = await api("/api/user-groups");
  state.userGroups = groupData.groups;
  renderAdminGroups();
  renderAdminMemberGroupFilter(filterGroupId);
  $("#adminGroupLabel").textContent = filterGroupId
    ? `— ${(state.userGroups.find(g => String(g.id) === filterGroupId) || {}).name || ""}`
    : "";
  const data = await api("/api/users");
  state.adminUsers = data.users;
  let users = data.users;
  if (filterGroupId) {
    users = users.filter(u => String(u.group_id) === filterGroupId);
  }
  renderAdminUserList(users);
}

function renderAdminMemberGroupFilter(value = "") {
  const select = $("#adminMemberGroupFilter");
  if (!select) return;
  select.innerHTML = `<option value="">全部用户组</option>${(state.userGroups || []).map((group) => (
    `<option value="${group.id}">${escapeHtml(group.name)}</option>`
  )).join("")}`;
  select.value = value;
}

function loadAdminSection(tabName) {
  $$(".admin-tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.tab === tabName));
  $$("#adminView .admin-content").forEach((panel) => {
    panel.classList.toggle("hidden", panel.id !== `admin${tabName.charAt(0).toUpperCase() + tabName.slice(1)}Panel`);
  });
  if (tabName === "users") {
    loadAdminSubTab($("#adminUsersPanel"), "groups");
    loadAdminUsers();
  } else if (tabName === "settings") {
    loadAdminSubTab($("#adminSettingsPanel"), "storage");
    loadAdminSettings();
  } else if (tabName === "audit") {
    loadAdminAudit();
  } else if (tabName === "templates") {
    renderHeaderConfigTab();
  }
}

function loadAdminSubTab(panel, subTabName) {
  if (!panel) return;
  panel.querySelectorAll(".admin-sub-tab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.subTab === subTabName);
  });
  panel.querySelectorAll(".admin-sub-panel").forEach((subPanel) => {
    subPanel.classList.toggle("hidden", subPanel.id !== `adminSub${subTabName.charAt(0).toUpperCase() + subTabName.slice(1)}Panel`);
  });
}

function renderAdminGroups() {
  const groups = state.userGroups || [];
  const selected = $("#adminView").dataset.selectedGroup || "";
  $("#adminUserGroupsList").innerHTML = `
    <table class="admin-group-table">
      <colgroup>
        <col class="admin-group-name-col" />
        <col class="admin-group-note-col" />
        <col class="admin-group-count-col" />
        <col class="admin-group-actions-col" />
      </colgroup>
      <thead>
        <tr>
          <th>组名</th>
          <th>备注</th>
          <th>成员数</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        ${groups.map((group) => adminGroupRowHtml(group, { selected: String(group.id) === selected })).join("")}
        <tr class="admin-group-add-row">
          <td colspan="4"><button class="add-row-button" type="button" data-add-group-row>＋</button></td>
        </tr>
      </tbody>
    </table>
  `;
}

function adminGroupRowHtml(group, options = {}) {
  const editing = Boolean(options.editing);
  const isNew = Boolean(options.isNew);
  const selected = Boolean(options.selected);
  return `
    <tr class="admin-group-row ${selected ? "selected" : ""} ${editing ? "editing" : ""}" data-group-id="${isNew ? "" : group.id}" data-new-group="${isNew ? "1" : "0"}">
      <td><input name="name" value="${escapeHtml(group.name || "")}" placeholder="组名称" ${editing ? "" : "disabled"} /></td>
      <td><input name="description" value="${escapeHtml(group.description || "")}" placeholder="备注" ${editing ? "" : "disabled"} /></td>
      <td class="member-count">${Number(group.member_count || 0)}</td>
      <td class="group-row-actions">
        ${editing
          ? `<button class="primary" type="button" data-save-group-row>保存</button><button type="button" data-cancel-group-row>取消</button>`
          : `<button type="button" data-edit-group>编辑</button><button type="button" data-delete-group>删除</button>`}
      </td>
    </tr>
  `;
}

function setAdminGroupRowEditing(row, editing) {
  row.classList.toggle("editing", editing);
  row.querySelectorAll("input").forEach((input) => { input.disabled = !editing; });
  row.querySelector(".group-row-actions").innerHTML = editing
    ? `<button class="primary" type="button" data-save-group-row>保存</button><button type="button" data-cancel-group-row>取消</button>`
    : `<button type="button" data-edit-group>编辑</button><button type="button" data-delete-group>删除</button>`;
  if (editing) row.querySelector("input[name='name']")?.focus();
}

function restoreAdminGroupRow(row) {
  if (row.dataset.newGroup === "1") {
    renderAdminGroups();
    return;
  }
  const group = (state.userGroups || []).find((item) => String(item.id) === row.dataset.groupId);
  if (!group) return;
  row.querySelector("input[name='name']").value = group.name || "";
  row.querySelector("input[name='description']").value = group.description || "";
  setAdminGroupRowEditing(row, false);
}

function expandNewAdminGroupRow(row) {
  row.outerHTML = adminGroupRowHtml({ name: "", description: "", member_count: 0 }, { editing: true, isNew: true });
  $("#adminUserGroupsList .admin-group-row[data-new-group='1'] input[name='name']")?.focus();
}

function renderAdminUserList(users) {
  $("#adminUsersList").innerHTML = `
    <table class="admin-member-table">
      <colgroup>
        <col class="admin-member-id-col" />
        <col class="admin-member-group-col" />
        <col class="admin-member-avatar-col" />
        <col class="admin-member-account-col" />
        <col class="admin-member-email-col" />
        <col class="admin-member-password-col" />
        <col class="admin-member-actions-col" />
      </colgroup>
      <thead>
        <tr>
          <th>用户ID</th>
          <th>用户组</th>
          <th>用户头像</th>
          <th>用户名</th>
          <th>邮箱</th>
          <th>密码</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        ${users.map((user) => adminUserRowHtml(user)).join("")}
        <tr class="admin-member-add-row">
          <td colspan="7"><button class="add-row-button" type="button" data-add-user-row>＋</button></td>
        </tr>
      </tbody>
    </table>
  `;
  $("#adminUsersList").dataset.users = JSON.stringify(users);
}

function adminGroupOptions(selectedId = "") {
  return `<option value="">未分组</option>${(state.userGroups || []).map((group) => (
    `<option value="${group.id}" ${String(group.id) === String(selectedId || "") ? "selected" : ""}>${escapeHtml(group.name)}</option>`
  )).join("")}`;
}

function formatUserId(id) {
  const number = Number(id);
  return Number.isFinite(number) ? String(number).padStart(4, "0") : "";
}

function adminUserRowHtml(user, options = {}) {
  const editing = Boolean(options.editing);
  const isNew = Boolean(options.isNew);
  const currentUserId = String(state.user?.id || "");
  const avatarContent = user.avatar_url
    ? `<img class="member-avatar" src="${escapeHtml(user.avatar_url)}" alt="" />`
    : `<span class="member-avatar-placeholder">${escapeHtml((user.username || "?")[0])}</span>`;
  return `
    <tr class="admin-member-row ${editing ? "editing" : ""}" data-user-id="${isNew ? "" : user.id}" data-new-user="${isNew ? "1" : "0"}">
      <td class="member-id">${isNew ? "" : formatUserId(user.id)}</td>
      <td><select name="group_id" ${editing ? "" : "disabled"}>${adminGroupOptions(user.group_id)}</select></td>
      <td class="member-avatar-cell">${!isNew && editing ? `<button class="member-avatar-button" type="button" data-upload-member-avatar title="上传头像">${avatarContent}</button>` : avatarContent}</td>
      <td><input name="username" value="${escapeHtml(user.username || "")}" placeholder="用户名" ${editing ? "" : "disabled"} /></td>
      <td><input name="email" value="${escapeHtml(user.email || "")}" placeholder="邮箱" type="email" ${editing ? "" : "disabled"} /></td>
      <td><input name="password" value="" placeholder="${isNew ? "初始密码" : "留空不修改"}" type="password" ${editing ? "" : "disabled"} /></td>
      <td class="member-row-actions">
        ${editing
          ? `<button class="primary" type="button" data-save-user-row>保存</button><button type="button" data-cancel-user-row>取消</button>`
          : `<button type="button" data-edit-user>编辑</button><button type="button" data-delete-user ${!isNew && currentUserId === String(user.id) ? "disabled" : ""}>删除</button>`}
      </td>
    </tr>
  `;
}

function setAdminUserRowEditing(row, editing) {
  if (editing && row.dataset.newUser !== "1") {
    const user = (state.adminUsers || []).find((item) => String(item.id) === row.dataset.userId);
    if (user) {
      row.outerHTML = adminUserRowHtml(user, { editing: true });
      $(`#adminUsersList .admin-member-row[data-user-id="${row.dataset.userId}"] select[name='group_id']`)?.focus();
      return;
    }
  }
  row.classList.toggle("editing", editing);
  row.querySelectorAll("input, select").forEach((field) => {
    field.disabled = !editing;
  });
  row.querySelector(".member-row-actions").innerHTML = editing
    ? `<button class="primary" type="button" data-save-user-row>保存</button><button type="button" data-cancel-user-row>取消</button>`
    : `<button type="button" data-edit-user>编辑</button><button type="button" data-delete-user ${String(state.user?.id || "") === row.dataset.userId ? "disabled" : ""}>删除</button>`;
  if (editing) row.querySelector("select[name='group_id']")?.focus();
}

function restoreAdminUserRow(row) {
  if (row.dataset.newUser === "1") {
    renderAdminUserList(filteredAdminUsers());
    return;
  }
  const user = (state.adminUsers || []).find((item) => String(item.id) === row.dataset.userId);
  if (!user) return;
  row.querySelector("input[name='username']").value = user.username || "";
  row.querySelector("input[name='email']").value = user.email || "";
  row.querySelector("select[name='group_id']").value = user.group_id || "";
  row.querySelector("input[name='password']").value = "";
  setAdminUserRowEditing(row, false);
}

function filteredAdminUsers() {
  const filterGroupId = $("#adminMemberGroupFilter")?.value || "";
  return (state.adminUsers || []).filter((user) => !filterGroupId || String(user.group_id) === filterGroupId);
}

function expandNewAdminUserRow(row) {
  const filterGroupId = $("#adminMemberGroupFilter")?.value || "";
  row.outerHTML = adminUserRowHtml({ username: "", email: "", group_id: filterGroupId }, { editing: true, isNew: true });
  $("#adminUsersList .admin-member-row[data-new-user='1'] select[name='group_id']")?.focus();
}

async function saveAdminUserGroup() {
  const form = $("#adminUserGroupForm");
  const data = Object.fromEntries(new FormData(form).entries());
  if (!data.name.trim()) { showMessage("用户组名称不能为空", "error"); return; }
  const method = data.id ? "PUT" : "POST";
  const path = data.id ? `/api/user-groups/${data.id}` : "/api/user-groups";
  await api(path, { method, body: JSON.stringify(data) });
  form.reset();
  await loadAdminUsers();
  showMessage("用户组已保存");
}

async function saveAdminUser() {
  const form = $("#adminUserForm");
  const data = Object.fromEntries(new FormData(form).entries());
  data.username = (data.username || "").trim();
  data.email = (data.email || "").trim();
  if (!data.username) { showMessage("用户名不能为空", "error"); return; }
  if (!data.email || !data.email.includes("@") || !data.email.includes(".")) {
    showMessage("请输入有效的邮箱地址", "error");
    return;
  }
  if (!data.password && !data.id) { showMessage("新增用户需要填写密码", "error"); return; }
  const selectedGroup = $("#adminView").dataset.selectedGroup || "";
  if (selectedGroup) data.group_id = Number(selectedGroup);
  const method = data.id ? "PUT" : "POST";
  const path = data.id ? `/api/users/${data.id}` : "/api/users";
  await api(path, { method, body: JSON.stringify(data) });
  form.reset();
  await loadAdminUsers();
  showMessage("用户已保存");
}

async function loadAdminSettings() {
  const data = await api("/api/settings");
  const s = data.settings;
  const storageForm = $("#adminStorageForm");
  storageForm.storage_type.value = s.storage_type || "local";
  storageForm.upload_dir.value = s.upload_dir || "uploads";
  storageForm.s3_endpoint.value = s.s3_endpoint || "";
  storageForm.s3_bucket.value = s.s3_bucket || "";
  storageForm.s3_region.value = s.s3_region || "";
  storageForm.s3_access_key.value = s.s3_access_key || "";
  storageForm.s3_secret_key.value = s.s3_secret_key || "";
  storageForm.s3_custom_domain.value = s.s3_custom_domain || "";
  toggleStorageConfigGroups(storageForm.storage_type.value);

  const emailForm = $("#adminEmailForm");
  emailForm.smtp_host.value = s.smtp_host || "";
  emailForm.smtp_port.value = s.smtp_port || "";
  emailForm.smtp_user.value = s.smtp_user || "";
  emailForm.smtp_pass.value = s.smtp_pass || "";
  emailForm.smtp_sender.value = s.smtp_sender || "";
}

function toggleStorageConfigGroups(storageType) {
  const activeType = storageType === "s3" ? "s3" : "local";
  $$(".storage-config-group").forEach((group) => {
    group.classList.toggle("hidden", group.dataset.storageGroup !== activeType);
  });
}

async function loadAdminAudit() {
  const data = await api("/api/audit");
  $("#adminAuditList").innerHTML = data.logs.map(log => `
    <article class="audit-item">
      <strong>${escapeHtml(log.action)}</strong>
      <span>${escapeHtml(log.target)} · ${escapeHtml(log.display_name || "系统")} · ${escapeHtml(log.created_at)}</span>
      <code>${escapeHtml(log.detail)}</code>
    </article>
  `).join("") || `<p class="muted">暂无修改记录</p>`;
}

function bindEvents() {
  let isSelecting = false;
  $("#loginForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const payload = Object.fromEntries(new FormData(event.currentTarget).entries());
      const data = await api("/api/login", { method: "POST", body: JSON.stringify(payload), headers: {} });
      state.token = data.token;
      state.user = data.user;
      state.permissions = data.permissions || { admin: false };
      state.editMode = false;
      localStorage.setItem("psl_token", state.token);
      showMain();
      await loadCatalog();
    } catch (error) {
      showMessage(error.message, "error");
      alert(error.message);
    }
  });
  $("#loginBtn").addEventListener("click", () => showLogin());
  $("#guestBtn").addEventListener("click", () => showMain());
  $("#closeLoginBtn").addEventListener("click", () => showMain());

  // --- Login / Register tabs ---
  $$(".login-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      $$(".login-tab").forEach(t => t.classList.toggle("active", t === tab));
      $("#loginForm").classList.toggle("hidden", tab.dataset.tab !== "login");
      $("#registerForm").classList.toggle("hidden", tab.dataset.tab !== "register");
      if (tab.dataset.tab === "register") refreshRegisterAvailability();
    });
  });

  // --- Send email verification code ---
  let codeCooldown = 0;
  let codeTimer = null;
  $("#sendCodeBtn").addEventListener("click", async () => {
    if (codeCooldown > 0) return;
    const email = $("#registerForm").email.value.trim();
    if (!email || !email.includes("@") || !email.includes(".")) {
      showMessage("请输入有效的邮箱地址", "error");
      return;
    }
    try {
      $("#sendCodeBtn").disabled = true;
      await api("/api/send-register-code", { method: "POST", body: JSON.stringify({ email }), headers: {} });
      showMessage("验证码已发送，请查收邮件");
      codeCooldown = 60;
      $("#sendCodeBtn").textContent = `${codeCooldown}s 后重发`;
      codeTimer = setInterval(() => {
        codeCooldown -= 1;
        if (codeCooldown <= 0) {
          clearInterval(codeTimer);
          codeTimer = null;
          $("#sendCodeBtn").textContent = "发送验证码";
          $("#sendCodeBtn").disabled = false;
        } else {
          $("#sendCodeBtn").textContent = `${codeCooldown}s 后重发`;
        }
      }, 1000);
    } catch (error) {
      showMessage(error.message, "error");
      $("#sendCodeBtn").disabled = false;
    }
  });

  // --- Register form ---
  $("#registerForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const payload = Object.fromEntries(new FormData(event.currentTarget).entries());
    if (!payload.email || !payload.code || !payload.username || !payload.password) {
      showMessage("请填写所有字段", "error");
      return;
    }
    if (payload.password.length < 6) {
      showMessage("密码至少 6 位", "error");
      return;
    }
    try {
      const data = await api("/api/register", { method: "POST", body: JSON.stringify(payload), headers: {} });
      state.token = data.token;
      state.user = data.user;
      state.permissions = data.permissions || { admin: false };
      state.editMode = false;
      localStorage.setItem("psl_token", state.token);
      showMain();
      await loadCatalog();
      showMessage("注册成功，已自动登录");
    } catch (error) {
      showMessage(error.message, "error");
    }
  });
  // --- Avatar dropdown ---
  $("#avatarBtn").addEventListener("click", () => {
    $("#avatarMenu").classList.toggle("hidden");
  });
  $("#dataManageBtn").addEventListener("click", async () => {
    await toggleDataManageMode();
  });
  document.addEventListener("click", (event) => {
    if (!$("#avatarMenu").classList.contains("hidden") && !event.target.closest("#avatarBtn") && !event.target.closest("#avatarMenu")) {
      closeAvatarMenu();
    }
  });
  // Avatar menu actions
  $("#avatarMenu").addEventListener("click", async (event) => {
    const action = event.target.closest("button")?.dataset.action;
    if (!action) return;
    closeAvatarMenu();
    if (action === "profile") openProfile();
    else if (action === "admin") showAdminPanel();
    else if (action === "logout") {
      await api("/api/logout", { method: "POST", body: JSON.stringify({}) }).catch(() => {});
      localStorage.removeItem("psl_token");
      state.token = "";
      state.user = null;
      state.permissions = { admin: false };
      state.editMode = false;
      document.body.classList.remove("editing-mode");
      showMain();
      await loadCatalog();
    }
  });
  // --- Profile dialog ---
  $("#closeProfileBtn").addEventListener("click", () => $("#profileDialog").close());
  $("#cancelProfileBtn").addEventListener("click", () => $("#profileDialog").close());
  $("#avatarUploadInput").addEventListener("change", async (event) => {
    const file = event.currentTarget.files?.[0];
    if (!file || !state.user) return;
    try {
      const data = await uploadAvatarFile(file);
      state.user = data.user;
      updateAuthUI();
      setAvatarDisplay($("#profileAvatarImage"), $("#profileAvatarInitial"), state.user.avatar_url, userInitial());
      showMessage("头像已更新");
    } catch (error) {
      showMessage(error.message, "error");
    } finally {
      event.currentTarget.value = "";
    }
  });
  $("#profileForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const payload = Object.fromEntries(new FormData(event.currentTarget).entries());
    const username = (payload.username || "").trim();
    const password = (payload.password || "").trim();
    if (!username && !password) {
      $("#profileDialog").close();
      return;
    }
    try {
      const data = await api("/api/profile", { method: "PUT", body: JSON.stringify({ username: username || undefined, password: password || undefined }) });
      state.user = data.user;
      updateAuthUI();
      $("#profileDialog").close();
      showMessage("个人资料已更新");
    } catch (error) {
      showMessage(error.message, "error");
    }
  });
  // --- Admin panel ---
  $("#backToMainBtn").addEventListener("click", hideAdminPanel);
  $("#adminSidebarToggle").addEventListener("click", () => {
    const collapsed = $("#adminSidebar").classList.toggle("collapsed");
    $("#adminSidebarToggle").textContent = collapsed ? "⇥" : "⇤";
    $("#adminSidebarToggle").title = collapsed ? "展开侧栏" : "收起侧栏";
  });
  $$(".admin-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      loadAdminSection(tab.dataset.tab);
    });
  });
  $$(".admin-sub-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      loadAdminSubTab(tab.closest(".admin-content"), tab.dataset.subTab);
      if (tab.dataset.subTab === "members") loadAdminUsers();
      if (tab.dataset.subTab === "storage" || tab.dataset.subTab === "email") loadAdminSettings();
    });
  });
  $("#adminMemberGroupFilter").addEventListener("change", () => loadAdminUsers());
  // Admin user group save
  $("#adminSaveGroupBtn").addEventListener("click", () => saveAdminUserGroup().catch(e => showMessage(e.message, "error")));
  // Admin user save
  $("#adminSaveUserBtn").addEventListener("click", () => saveAdminUser().catch(e => showMessage(e.message, "error")));
  // Admin user group list: select/edit/delete
  $("#adminUserGroupsList").addEventListener("click", async (event) => {
    const add = event.target.closest("[data-add-group-row]");
    const row = event.target.closest(".admin-group-row");
    if (add) {
      expandNewAdminGroupRow(event.target.closest(".admin-group-add-row"));
      return;
    }
    if (!row) return;
    const edit = event.target.closest("[data-edit-group]");
    const save = event.target.closest("[data-save-group-row]");
    const cancel = event.target.closest("[data-cancel-group-row]");
    const remove = event.target.closest("[data-delete-group]");
    if (edit) {
      setAdminGroupRowEditing(row, true);
      return;
    }
    if (cancel) {
      restoreAdminGroupRow(row);
      return;
    }
    if (save) {
      const name = row.querySelector("input[name='name']").value.trim();
      const description = row.querySelector("input[name='description']").value.trim();
      if (!name) {
        showMessage("用户组名称不能为空", "error");
        row.querySelector("input[name='name']").focus();
        return;
      }
      const isNew = row.dataset.newGroup === "1";
      const group = (state.userGroups || []).find((item) => String(item.id) === row.dataset.groupId);
      const path = isNew ? "/api/user-groups" : `/api/user-groups/${row.dataset.groupId}`;
      const method = isNew ? "POST" : "PUT";
      await api(path, {
        method,
        body: JSON.stringify({ name, description, sort_order: group?.sort_order || 0 }),
      });
      await loadAdminUsers();
      showMessage(isNew ? "用户组已新增" : "用户组已保存");
      return;
    }
    if (remove && window.confirm("确认删除该用户组？")) {
      await api(`/api/user-groups/${row.dataset.groupId}`, { method: "DELETE" });
      $("#adminUserGroupForm").reset();
      $("#adminSaveGroupBtn").textContent = "新增用户组";
      await loadAdminUsers();
      showMessage("用户组已删除");
      return;
    }
    if (!event.target.closest("button, input")) {
      $("#adminView").dataset.selectedGroup = row.dataset.groupId;
      await loadAdminUsers();
    }
  });
  $("#adminUserGroupForm").addEventListener("reset", () => { $("#adminSaveGroupBtn").textContent = "新增用户组"; });
  // Admin user list: inline edit/delete/add
  $("#adminUsersList").addEventListener("click", async (event) => {
    const add = event.target.closest("[data-add-user-row]");
    const row = event.target.closest(".admin-member-row");
    if (add) {
      expandNewAdminUserRow(event.target.closest(".admin-member-add-row"));
      return;
    }
    if (!row) return;
    const edit = event.target.closest("[data-edit-user]");
    const save = event.target.closest("[data-save-user-row]");
    const cancel = event.target.closest("[data-cancel-user-row]");
    const remove = event.target.closest("[data-delete-user]");
    const avatarUpload = event.target.closest("[data-upload-member-avatar]");
    if (avatarUpload) {
      if (!row.classList.contains("editing") || row.dataset.newUser === "1") return;
      const file = await chooseAvatarFile();
      if (!file) return;
      try {
        await uploadAvatarFile(file, row.dataset.userId);
        await loadAdminUsers();
        showMessage("成员头像已更新");
      } catch (error) {
        showMessage(error.message, "error");
      }
      return;
    }
    if (edit) {
      setAdminUserRowEditing(row, true);
      return;
    }
    if (cancel) {
      restoreAdminUserRow(row);
      return;
    }
    if (save) {
      const isNew = row.dataset.newUser === "1";
      const username = row.querySelector("input[name='username']").value.trim();
      const email = row.querySelector("input[name='email']").value.trim();
      const groupId = row.querySelector("select[name='group_id']").value;
      const password = row.querySelector("input[name='password']").value.trim();
      if (!username) {
        showMessage("用户名不能为空", "error");
        row.querySelector("input[name='username']").focus();
        return;
      }
      if (!email || !email.includes("@") || !email.includes(".")) {
        showMessage("请输入有效的邮箱地址", "error");
        row.querySelector("input[name='email']").focus();
        return;
      }
      if (isNew && !password) {
        showMessage("新增成员需要填写初始密码", "error");
        row.querySelector("input[name='password']").focus();
        return;
      }
      const payload = {
        username,
        email,
        group_id: groupId ? Number(groupId) : null,
      };
      if (password) payload.password = password;
      const path = isNew ? "/api/users" : `/api/users/${row.dataset.userId}`;
      const method = isNew ? "POST" : "PUT";
      await api(path, { method, body: JSON.stringify(payload) });
      await loadAdminUsers();
      showMessage(isNew ? "成员已新增" : "成员已保存");
      return;
    }
    if (remove && window.confirm("确认删除该用户？")) {
      await api(`/api/users/${row.dataset.userId}`, { method: "DELETE" });
      await loadAdminUsers();
      showMessage("用户已删除");
    }
  });
  $("#adminUserForm").addEventListener("reset", () => { $("#adminUserForm").username.disabled = false; });
  // Admin storage settings save
  $("#adminStorageForm").storage_type.addEventListener("change", (event) => {
    toggleStorageConfigGroups(event.target.value);
  });
  $("#adminStorageForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const payload = Object.fromEntries(new FormData(event.currentTarget).entries());
    try {
      await api("/api/settings", { method: "PUT", body: JSON.stringify(payload), headers: {} });
      showMessage("存储配置已保存", "success");
    } catch (error) {
      showMessage(error.message, "error");
    }
  });
  // Admin email settings save
  $("#adminEmailForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const payload = Object.fromEntries(new FormData(event.currentTarget).entries());
    try {
      await api("/api/settings", { method: "PUT", body: JSON.stringify(payload), headers: {} });
      showMessage("邮箱配置已保存", "success");
    } catch (error) {
      showMessage(error.message, "error");
    }
  });

  const addProductBtn = $("#addProductBtn");
  if (addProductBtn) addProductBtn.addEventListener("click", () => openProductManage());
  const uploadBtn = $("#uploadBtn");
  if (uploadBtn) uploadBtn.addEventListener("click", () => $("#uploadDialog").showModal());
  $("#templateAddParamBtn").addEventListener("click", () => openParameterDialog());
  const adminParamBtn = $("#adminTemplateAddParamBtn");
  if (adminParamBtn) adminParamBtn.addEventListener("click", () => openParameterDialog());
  $("#closeProductBtn").addEventListener("click", () => $("#productDialog").close());
  $("#cancelProductBtn").addEventListener("click", () => $("#productDialog").close());
  $("#closeParamBtn").addEventListener("click", () => $("#paramDialog").close());
  $("#cancelParamBtn").addEventListener("click", () => $("#paramDialog").close());
  $("#closeTemplateBtn").addEventListener("click", () => $("#templateDialog").close());
  $("#saveProductBtn").addEventListener("click", () => saveProduct().catch((error) => showMessage(error.message, "error")));
  $("#closeProductManageBtn").addEventListener("click", () => $("#productManageDialog").close());
  $("#saveManageProductBtn").addEventListener("click", () => saveManageProduct().catch((error) => showMessage(error.message, "error")));
  $("#productManageList").addEventListener("click", async (event) => {
    const edit = event.target.closest("[data-edit-product]");
    const remove = event.target.closest("[data-delete-product]");
    if (edit) {
      const product = state.catalog.products.find((item) => item.id === Number(edit.dataset.editProduct));
      if (product) openProductDialog(product);
    }
    if (remove && window.confirm(`确认删除产品 ${remove.closest(".user-item").querySelector("strong").textContent}？相关参数值也会一并删除。`)) {
      await api(`/api/products/${remove.dataset.deleteProduct}`, { method: "DELETE" });
      await loadCatalog();
      renderProductManageList();
      showMessage("产品已删除");
    }
  });
  $("#saveParamBtn").addEventListener("click", () => saveParameter().catch((error) => showMessage(error.message, "error")));
  $("#submitUploadBtn").addEventListener("click", () => submitUpload().catch((error) => showMessage(error.message, "error")));
  // --- template list: click, drag-sort (bound to both dialog + admin panel) ---
  let templateDragSource = null;
  let templateDragType = null; // 'group' | 'param'

  function bindTemplateEvents(selector) {
    const container = $(selector);
    if (!container) return;

    container.addEventListener("click", async (event) => {
      const edit = event.target.closest("[data-edit-param]");
      const remove = event.target.closest("[data-delete-param]");
      if (edit) {
        const parameter = state.catalog.parameters.find((item) => item.id === Number(edit.dataset.editParam));
        openParameterDialog(parameter);
      }
      if (remove && window.confirm("确认删除该参数模板？对应参数值也会删除。")) {
        await api(`/api/parameters/${remove.dataset.deleteParam}`, { method: "DELETE" });
        await loadCatalog();
        if ($("#templateDialog").open) renderTemplateList("#templateList");
        renderTemplateList("#adminTemplateList");
        showMessage("参数模板已删除");
      }
    });

    container.addEventListener("dragstart", (event) => {
      const h3 = event.target.closest("h3");
      if (h3 && h3.closest(".template-group")) {
        const groupEl = h3.closest(".template-group");
        templateDragSource = groupEl;
        templateDragType = "group";
        groupEl.classList.add("dragging");
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", groupEl.dataset.groupId);
        return;
      }
      const paramEl = event.target.closest(".template-item");
      if (paramEl && !event.target.closest("button")) {
        templateDragSource = paramEl;
        templateDragType = "param";
        paramEl.classList.add("dragging");
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", paramEl.dataset.paramId);
        return;
      }
      event.preventDefault();
    });

    container.addEventListener("dragend", () => {
      if (templateDragSource) templateDragSource.classList.remove("dragging");
      templateDragSource = null;
      templateDragType = null;
      container.querySelectorAll(".drag-over").forEach((el) => el.classList.remove("drag-over"));
    });

    container.addEventListener("dragover", (event) => {
      event.preventDefault();
      if (!templateDragType) return;
      event.dataTransfer.dropEffect = "move";
      container.querySelectorAll(".drag-over").forEach((el) => el.classList.remove("drag-over"));
      if (templateDragType === "group") {
        const groupEl = event.target.closest(".template-group");
        if (groupEl && groupEl !== templateDragSource) groupEl.classList.add("drag-over");
      } else if (templateDragType === "param") {
        const paramEl = event.target.closest(".template-item");
        if (paramEl && paramEl !== templateDragSource && paramEl.dataset.groupId === templateDragSource.dataset.groupId) {
          paramEl.classList.add("drag-over");
        }
      }
    });

    container.addEventListener("drop", async (event) => {
      event.preventDefault();
      if (!templateDragSource || !templateDragType) return;

      if (templateDragType === "group") {
        const target = event.target.closest(".template-group");
        if (!target || target === templateDragSource) return;
        const allGroups = container.querySelectorAll(".template-group");
        const groupId = Number(templateDragSource.dataset.groupId);
        const targetGroupId = Number(target.dataset.groupId);
        const targetGroup = state.catalog.groups.find((g) => g.id === targetGroupId);
        const newSort = targetGroup ? targetGroup.sort_order : 10;
        try {
          await api(`/api/groups/${groupId}`, { method: "PUT", body: JSON.stringify({ sort_order: newSort }) });
          const ordered = Array.from(allGroups).map((el) => Number(el.dataset.groupId));
          const movedIndex = ordered.indexOf(groupId);
          const newIndex = ordered.indexOf(targetGroupId);
          if (movedIndex >= 0) ordered.splice(movedIndex, 1);
          ordered.splice(newIndex, 0, groupId);
          await Promise.all(ordered.map((id, i) =>
            api(`/api/groups/${id}`, { method: "PUT", body: JSON.stringify({ sort_order: (i + 1) * 10 }) })
          ));
          await loadCatalog();
          renderTemplateList("#templateList");
          renderTemplateList("#adminTemplateList");
          showMessage("分组排序已保存");
        } catch (error) {
          showMessage(error.message, "error");
        }
        return;
      }

      if (templateDragType === "param") {
        const target = event.target.closest(".template-item");
        if (!target || target === templateDragSource) return;
        if (target.dataset.groupId !== templateDragSource.dataset.groupId) return;
        const group = target.closest(".template-group");
        const siblings = Array.from(group.querySelectorAll(".template-item"));
        const paramId = Number(templateDragSource.dataset.paramId);
        const newIndex = siblings.indexOf(target);
        const targetParam = state.catalog.parameters.find((p) => p.id === Number(target.dataset.paramId));
        const newSort = targetParam ? targetParam.sort_order : (newIndex + 1) * 10;
        try {
          await api(`/api/parameters/${paramId}`, { method: "PUT", body: JSON.stringify({ sort_order: newSort }) });
          const ordered = siblings.map((el) => Number(el.dataset.paramId));
          const movedIndex = ordered.indexOf(paramId);
          if (movedIndex >= 0) ordered.splice(movedIndex, 1);
          ordered.splice(newIndex, 0, paramId);
          await Promise.all(ordered.map((id, i) =>
            api(`/api/parameters/${id}`, { method: "PUT", body: JSON.stringify({ sort_order: (i + 1) * 10 }) })
          ));
          await loadCatalog();
          renderTemplateList("#templateList");
          renderTemplateList("#adminTemplateList");
          showMessage("参数排序已保存");
        } catch (error) {
          showMessage(error.message, "error");
        }
      }
    });
  }

  bindTemplateEvents("#templateList");
  bindTemplateEvents("#adminTemplateList");
  // --- end template events ---

  // --- 表格交互 & 选择区：待重构 ---

  // --- Image lightbox ---
  $("#lightboxClose").addEventListener("click", closeLightbox);
  $("#lightboxOverlay").addEventListener("click", (event) => {
    if (event.target === $("#lightboxOverlay")) closeLightbox();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !$("#lightboxOverlay").hasAttribute("hidden")) {
      closeLightbox();
    }
  });
}

bindEvents();
restoreSession();
