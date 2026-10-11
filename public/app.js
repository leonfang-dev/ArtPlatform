const $ = id => document.getElementById(id);
const viewport = $('viewport');
const world = $('world');
const connections = $('connections');
const grid = $('grid');
const intro = $('canvasIntro');
const promptInput = $('prompt');
const storageKey = 'artplatform-board-v1';
const themeKey = 'artplatform-theme';
function applyTheme(theme) {
  const current = theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = current;
  document.querySelector('meta[name="theme-color"]').content = current === 'dark' ? '#151720' : '#f3f1ec';
  $('darkMode').setAttribute('aria-pressed', String(current === 'dark'));
  $('lightMode').setAttribute('aria-pressed', String(current === 'light'));
  try { localStorage.setItem(themeKey, current); } catch {}
}
$('darkMode').addEventListener('click', () => applyTheme('dark'));
$('lightMode').addEventListener('click', () => applyTheme('light'));
applyTheme(document.documentElement.dataset.theme);

const state = { items: [], selected: null, panX: 0, panY: 0, zoom: 1 };
let gesture = null;
let toastTimer;
let pollTimers = new Map();
let editSourceId = null;
let modelTasks = [];
let model3dConfigured = null;
let activeModelTaskId = null;
const modelPollTimers = new Map();
let needsHydration = false;
const modelStorageKey = 'artplatform-model';
let modelCatalog = [
  { id: 'nano-banana-2.1', label: 'Nano Banana 2.1', prices: { '1k': 0.04, '2k': 0.06, '4k': 0.135 }, referenceFee: 0.002 },
  { id: 'nano-banana-2', label: 'Nano Banana 2', prices: { '1k': 0.07, '2k': 0.105, '4k': 0.14 }, referenceFee: 0 },
  { id: 'nano-banana-pro', label: 'Nano Banana Pro', prices: { '1k': 0.14, '2k': 0.14, '4k': 0.24 }, referenceFee: 0 }
];
function selectedModel() {
  return modelCatalog.find(model => model.id === $('modelSelect').value) || modelCatalog[0];
}
function modelLabel(id) {
  return modelCatalog.find(model => model.id === id)?.label || 'Nano Banana 2.1';
}
function updateModel() {
  $('activeModel').textContent = '✦ ' + selectedModel().label;
  try { localStorage.setItem(modelStorageKey, selectedModel().id); } catch {}
  updatePrice();
}

function editSource() { return state.items.find(x => x.localId === editSourceId); }
function updatePrice() {
  const model = selectedModel();
  const base = model.prices[$('resolution').value];
  const amount = (base + (editSource() ? model.referenceFee : 0)).toFixed(3).replace(/0$/, '');
  $('price').textContent = '约 ' + String.fromCharCode(36) + amount + ' / 张';
}
function setEditSource(item) {
  editSourceId = item?.localId || null;
  const source = editSource();
  $('sourceBar').classList.toggle('hidden', !source);
  $('composerTitle').textContent = source ? '编辑参考图片' : '创建新图片';
  $('composerNote').textContent = source ? '保留原图，生成新版本' : '可粘贴图片作为参考';
  $('submitLabel').textContent = source ? '编辑图片' : '生成图片';
  promptInput.placeholder = source ? '描述要修改的内容，以及哪些部分保持不变…' : '描述你脑海中的画面… 例如：魔法森林中的古老石门，蓝色符文微微发光';
  if (source) {
    $('sourceThumb').src = source.imageUrl;
    $('sourcePrompt').textContent = source.prompt;
    const [width, height] = source.aspectRatio.split(':').map(Number);
    if (width > 0 && height > 0) {
      const target = width / height;
      const choices = [...$('ratio').options];
      choices.sort((a, b) => {
        const ratioOf = option => { const [w, h] = option.value.split(':').map(Number); return w / h; };
        return Math.abs(Math.log(ratioOf(a) / target)) - Math.abs(Math.log(ratioOf(b) / target));
      });
      $('ratio').value = choices[0].value;
    }
  }
  updatePrice();
}
function save() {
  localStorage.setItem(storageKey, JSON.stringify({ items: state.items, panX: state.panX, panY: state.panY, zoom: state.zoom }));
}

function restore() {
  try {
    const raw = localStorage.getItem(storageKey);
    needsHydration = raw === null;
    const saved = JSON.parse(raw || '{}');
    if (Array.isArray(saved.items)) state.items = saved.items.filter(x => x && x.localId && x.prompt).slice(0, 200);
    if (Number.isFinite(saved.panX)) state.panX = saved.panX;
    if (Number.isFinite(saved.panY)) state.panY = saved.panY;
    if (Number.isFinite(saved.zoom)) state.zoom = Math.max(.3, Math.min(2.5, saved.zoom));
  } catch {}
}

function showToast(text) {
  const el = $('toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3800);
}

function setTransform() {
  world.style.transform = 'translate(' + state.panX + 'px,' + state.panY + 'px) scale(' + state.zoom + ')';
  grid.style.backgroundSize = (24 * state.zoom) + 'px ' + (24 * state.zoom) + 'px';
  grid.style.backgroundPosition = state.panX + 'px ' + state.panY + 'px';
  $('zoomValue').textContent = Math.round(state.zoom * 100) + '%';
  save();
}

function zoomAt(clientX, clientY, next) {
  next = Math.max(.3, Math.min(2.5, next));
  const rect = viewport.getBoundingClientRect();
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  const worldX = (x - state.panX) / state.zoom;
  const worldY = (y - state.panY) / state.zoom;
  state.zoom = next;
  state.panX = x - worldX * next;
  state.panY = y - worldY * next;
  setTransform();
}

function statusLabel(item) {
  if (item.status === 'completed') return '已完成';
  if (['failed', 'cancelled', 'timeout', 'deleted'].includes(item.status)) return '生成失败';
  return '生成中';
}

function imageHeight(ratio) {
  const [w, h] = ratio.split(':').map(Number);
  return Math.round(Math.min(390, Math.max(205, 290 * h / w)));
}

function latestModel(item) {
  return modelTasks.filter(task => task.sourceTaskId === item?.id && task.provider === 'wavespeed-meshy-v7.1').sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

function modelButtonText(task) {
  if (!task || ['failed', 'cancelled', 'timeout', 'deleted'].includes(task.status)) return '◈ 生成 3D · 约 $1.44';
  return task.status === 'completed' ? '◈ 查看 3D 模型' : '◈ 3D 生成中 · 查看进度';
}

function renderConnections() {
  connections.replaceChildren();
  const svgNS = 'http://www.w3.org/2000/svg';
  const defs = document.createElementNS(svgNS, 'defs');
  const marker = document.createElementNS(svgNS, 'marker');
  marker.setAttribute('id', 'relationArrow');
  marker.setAttribute('markerWidth', '8');
  marker.setAttribute('markerHeight', '8');
  marker.setAttribute('refX', '6');
  marker.setAttribute('refY', '4');
  marker.setAttribute('orient', 'auto');
  const arrow = document.createElementNS(svgNS, 'path');
  arrow.setAttribute('d', 'M1 1 L7 4 L1 7');
  arrow.setAttribute('class', 'connection-arrow');
  marker.append(arrow);
  defs.append(marker);
  connections.append(defs);
  for (const child of state.items) {
    if (!child.sourceTaskId) continue;
    const parent = state.items.find(item => item.id === child.sourceTaskId);
    if (!parent) continue;
    const right = child.x >= parent.x;
    const x1 = right ? parent.x + 290 : parent.x;
    const x2 = right ? child.x : child.x + 290;
    const y1 = parent.y + imageHeight(parent.aspectRatio) / 2;
    const y2 = child.y + imageHeight(child.aspectRatio) / 2;
    const bend = Math.max(48, Math.min(120, Math.abs(x2 - x1) * 0.45)) * (right ? 1 : -1);
    const path = document.createElementNS(svgNS, 'path');
    path.setAttribute('d', 'M ' + x1 + ' ' + y1 + ' C ' + (x1 + bend) + ' ' + y1 + ', ' + (x2 - bend) + ' ' + y2 + ', ' + x2 + ' ' + y2);
    path.setAttribute('class', 'connection-line');
    path.setAttribute('marker-end', 'url(#relationArrow)');
    connections.append(path);
  }
}

function showModel(task) {
  activeModelTaskId = task.id;
  $('modelModal').classList.remove('hidden');
  renderModelModal();
}

function hideModel() {
  activeModelTaskId = null;
  $('modelModal').classList.add('hidden');
  $('modelViewer').removeAttribute('src');
}

function renderModelModal() {
  const task = modelTasks.find(item => item.id === activeModelTaskId);
  if (!task) return;
  const ready = task.status === 'completed' && task.modelUrl;
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(task.createdAt)) / 60000));
  const waiting = 'Meshy 正在生成模型（可能需要数分钟）' + (minutes ? ' · 已等待 ' + minutes + ' 分钟' : '') + (Number.isFinite(task.progress) ? ' · ' + task.progress + '%' : '');
  $('modelStatus').textContent = ready ? '模型已保存在本机 · 拖动旋转，滚轮缩放' : task.error || waiting;
  $('modelLoading').textContent = task.error || waiting;
  $('modelLoading').classList.toggle('hidden', ready);
  $('modelViewer').classList.toggle('hidden', !ready);
  $('modelDownload').classList.toggle('hidden', !ready);
  if (ready) {
    $('modelViewer').src = task.modelUrl;
    $('modelDownload').href = task.modelUrl;
    $('modelDownload').download = 'artplatform-' + task.id + '.glb';
    setTimeout(() => {
      if (activeModelTaskId === task.id && !customElements.get('model-viewer')) $('modelStatus').textContent = '3D 查看器未加载，请使用下方按钮下载 GLB';
    }, 5000);
  }
}

async function pollModel(task) {
  try {
    const result = await api('/api/models/' + encodeURIComponent(task.id));
    Object.assign(task, result.task);
    render();
    if (activeModelTaskId === task.id) renderModelModal();
    if (!['completed', 'failed', 'cancelled', 'timeout', 'deleted'].includes(task.status)) {
      modelPollTimers.set(task.id, setTimeout(() => pollModel(task), 3000));
    } else if (task.status === 'completed') showToast('3D 模型已生成，可在网页中查看');
    else showToast(task.error || '3D 模型生成失败');
  } catch (error) {
    modelPollTimers.set(task.id, setTimeout(() => pollModel(task), 5000));
    if (activeModelTaskId === task.id) $('modelStatus').textContent = '查询暂时失败，正在重试…';
  }
}

async function openModelFor(item) {
  if (!item || item.status !== 'completed' || !item.id) return showToast('请先选择一张已完成的图片');
  const existing = latestModel(item);
  if (existing && !['failed', 'cancelled', 'timeout', 'deleted'].includes(existing.status)) return showModel(existing);
  if (model3dConfigured === false) return showToast('请先在 .env 中配置 WAVESPEED_API_KEY，然后重启服务');
  try {
    showToast('正在提交 Meshy 任务…');
    const result = await api('/api/models', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceTaskId: item.id, generateType: 'Normal' })
    });
    const task = result.task;
    modelTasks.push(task);
    render();
    showModel(task);
    if (task.status !== 'completed') pollModel(task);
  } catch (error) { showToast(error.message); }
}

function renderInspector() {
  const item = state.items.find(x => x.localId === state.selected);
  $('inspectorEmpty').classList.toggle('hidden', Boolean(item));
  $('inspectorContent').classList.toggle('hidden', !item);
  if (!item) return;
  const preview = $('inspectorPreview');
  preview.replaceChildren();
  if (item.imageUrl) {
    const img = new Image();
    img.src = item.imageUrl;
    img.alt = item.prompt;
    preview.append(img);
  } else preview.textContent = '✦';
  $('detailPrompt').textContent = item.prompt;
  $('detailStatus').textContent = item.error || statusLabel(item);
  $('detailSize').textContent = item.aspectRatio + ' / ' + (item.mode === 'import' ? '原图' : item.resolution.toUpperCase());
  $('detailModel').textContent = item.mode === 'import' ? '本地导入' : modelLabel(item.modelId);
  $('editButton').classList.toggle('hidden', item.status !== 'completed' || !item.imageUrl);
  $('modelButton').classList.toggle('hidden', item.status !== 'completed' || !item.imageUrl);
  $('modelButton').textContent = modelButtonText(latestModel(item));
  const parent = state.items.find(x => x.id && x.id === item.sourceTaskId);
  $('sourceDetailRow').classList.toggle('hidden', !item.sourceTaskId);
  $('detailSource').textContent = parent ? parent.prompt.slice(0, 25) : '画布中的原图';
  const link = $('downloadLink');
  link.classList.toggle('hidden', !item.imageUrl);
  if (item.imageUrl) { link.href = item.imageUrl; link.download = 'artplatform-' + item.localId + '.' + item.imageUrl.split('.').pop(); }
}

function render() {
  world.replaceChildren(connections);
  for (const item of state.items) {
    const card = document.createElement('article');
    card.className = 'image-card' + (item.localId === state.selected ? ' selected' : '');
    card.dataset.id = item.localId;
    card.style.left = item.x + 'px';
    card.style.top = item.y + 'px';
    const art = document.createElement('div');
    art.className = 'card-image' + (['completed', 'failed'].includes(item.status) ? '' : ' loading');
    art.style.height = imageHeight(item.aspectRatio) + 'px';
    if (item.imageUrl) {
      const img = new Image();
      img.src = item.imageUrl;
      img.alt = item.prompt;
      art.append(img);
    } else {
      const mark = document.createElement('span');
      mark.className = 'placeholder';
      mark.textContent = '✦';
      art.append(mark);
      const wait = document.createElement('span');
      wait.className = 'wait';
      wait.textContent = item.error || (item.status === 'submitting' ? '正在提交…' : '正在生成…');
      art.append(wait);
    }
    const footer = document.createElement('div');
    footer.className = 'card-footer';
    const line = document.createElement('div');
    line.className = 'card-line';
    const type = document.createElement('span');
    type.className = 'card-type';
    type.textContent = item.mode === 'import' ? 'IMPORTED' : item.sourceTaskId ? 'AI EDIT' : 'AI IMAGE';
    const status = document.createElement('span');
    status.className = 'card-status';
    status.textContent = statusLabel(item);
    line.append(type, status);
    const desc = document.createElement('p');
    desc.className = 'card-prompt';
    desc.textContent = item.prompt;
    const size = document.createElement('div');
    size.className = 'card-size';
    size.textContent = item.aspectRatio + ' · ' + (item.mode === 'import' ? '本地导入' : item.resolution.toUpperCase() + ' · ' + modelLabel(item.modelId));
    footer.append(line, desc, size);
    if (item.status === 'completed' && item.imageUrl) {
      const edit = document.createElement('button');
      edit.className = 'card-edit-button';
      edit.type = 'button';
      edit.textContent = '✦ 以此图编辑';
      footer.append(edit);
      const model = document.createElement('button');
      model.className = 'card-model-button';
      model.type = 'button';
      model.textContent = modelButtonText(latestModel(item));
      footer.append(model);
    }
    card.append(art, footer);
    world.append(card);
  }
  intro.classList.toggle('hidden', state.items.length > 0);
  $('itemCount').textContent = state.items.length;
  renderConnections();
  renderInspector();
  save();
}

function addItem(prompt, aspectRatio, resolution, source) {
  const bounds = viewport.getBoundingClientRect();
  const baseX = (bounds.width / 2 - state.panX) / state.zoom - 145;
  const baseY = (bounds.height * .36 - state.panY) / state.zoom - imageHeight(aspectRatio) / 2;
  const n = state.items.length;
  const item = { localId: crypto.randomUUID(), id: null, prompt, aspectRatio, resolution, modelId: selectedModel().id, sourceTaskId: source?.id || null, x: source ? source.x + 335 : Math.round(baseX + (n % 4) * 32), y: source ? source.y + 30 : Math.round(baseY + (n % 4) * 32), status: 'submitting', imageUrl: null, error: null };
  state.items.push(item);
  state.selected = item.localId;
  render();
  return item;
}

async function normalizeImage(file) {
  if (['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) return file;
  if (!file.type.startsWith('image/')) throw new Error('剪贴板内容不是图片');
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    const png = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!png) throw new Error('无法转换剪贴板图片');
    return new File([png], 'pasted-image.png', { type: 'image/png' });
  } finally {
    bitmap.close();
  }
}

async function importImage(file) {
  if (!file) return showToast('请复制或选择一张图片');
  if (file.size > 20 * 1024 * 1024) return showToast('图片不能超过 20 MB');
  $('uploadImageButton').disabled = true;
  showToast('正在导入参考图片…');
  try {
    const image = await normalizeImage(file);
    if (image.size > 20 * 1024 * 1024) throw new Error('图片不能超过 20 MB');
    const result = await api('/api/imports', { method: 'POST', headers: { 'Content-Type': image.type }, body: image });
    let ratio = '1:1';
    try {
      const bitmap = await createImageBitmap(image);
      ratio = bitmap.width + ':' + bitmap.height;
      bitmap.close();
    } catch {}
    const item = addItem('本地参考图片', ratio, 'original');
    Object.assign(item, result.task);
    item.aspectRatio = ratio;
    item.prompt = file.name && file.name !== 'image.png' ? '本地参考图片 · ' + file.name.slice(0, 80) : '粘贴的参考图片';
    render();
    setEditSource(item);
    promptInput.focus();
    showToast('图片已导入，可输入修改要求');
  } catch (error) {
    showToast(error.message);
  } finally {
    $('uploadImageButton').disabled = false;
  }
}

async function api(url, options) {
  const response = await fetch(url, options);
  const body = await response.json();
  if (!response.ok) {
    if (response.status === 404 && url === '/api/imports') throw new Error('本地服务仍是旧版本，请关闭旧终端并重新运行 npm start');
    throw new Error(body.error || '请求失败');
  }
  return body;
}

async function poll(item) {
  if (!item.id) return;
  try {
    const result = await api('/api/generations/' + encodeURIComponent(item.id));
    if (!state.items.includes(item)) return;
    Object.assign(item, { status: result.task.status, imageUrl: result.task.imageUrl, error: result.task.error });
    render();
    if (!['completed', 'failed', 'cancelled', 'timeout', 'deleted'].includes(item.status)) {
      pollTimers.set(item.localId, setTimeout(() => poll(item), 2500));
    } else if (item.status === 'completed') {
      showToast('图片已生成并保存到本机');
    } else showToast(item.error || '图片生成失败');
  } catch (error) {
    item.error = error.message;
    render();
    pollTimers.set(item.localId, setTimeout(() => poll(item), 5000));
  }
}

async function generate(event) {
  event.preventDefault();
  const prompt = promptInput.value.trim();
  if (!prompt) return showToast('先写下你想生成的画面');
  const aspectRatio = $('ratio').value;
  const resolution = $('resolution').value;
  const source = editSource();
  if (editSourceId && (!source || source.status !== 'completed' || !source.id)) return showToast('参考图尚未生成完成');
  const item = addItem(prompt, aspectRatio, resolution, source);
  promptInput.value = '';
  $('generateButton').disabled = true;
  try {
    const result = await api('/api/generations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, aspectRatio, resolution, modelId: selectedModel().id, sourceTaskId: source?.id || null })
    });
    Object.assign(item, result.task);
    render();
    if (item.status !== 'completed') poll(item);
    else showToast('图片已生成并保存到本机');
  } catch (error) {
    item.status = 'failed';
    item.error = error.message;
    promptInput.value = prompt;
    render();
    showToast(error.message);
  } finally {
    $('generateButton').disabled = false;
  }
}

function fit() {
  if (!state.items.length) { state.panX = 0; state.panY = 0; state.zoom = 1; return setTransform(); }
  const minX = Math.min(...state.items.map(x => x.x));
  const minY = Math.min(...state.items.map(x => x.y));
  const maxX = Math.max(...state.items.map(x => x.x + 290));
  const maxY = Math.max(...state.items.map(x => x.y + imageHeight(x.aspectRatio) + 145));
  const bounds = viewport.getBoundingClientRect();
  state.zoom = Math.max(.3, Math.min(1.3, Math.min((bounds.width - 80) / (maxX - minX), (bounds.height - 240) / (maxY - minY))));
  state.panX = bounds.width / 2 - (minX + maxX) / 2 * state.zoom;
  state.panY = (bounds.height - 100) / 2 - (minY + maxY) / 2 * state.zoom;
  setTransform();
}

viewport.addEventListener('pointerdown', event => {
  if (event.target.closest('.composer') || event.target.closest('.card-edit-button') || event.target.closest('.card-model-button')) return;
  const card = event.target.closest('.image-card');
  if (card) {
    state.selected = card.dataset.id;
    gesture = { kind: 'card', id: card.dataset.id, startX: event.clientX, startY: event.clientY, itemX: state.items.find(x => x.localId === card.dataset.id).x, itemY: state.items.find(x => x.localId === card.dataset.id).y };
    renderInspector();
    for (const el of world.children) el.classList.toggle('selected', el.dataset.id === state.selected);
  } else {
    gesture = { kind: 'pan', startX: event.clientX, startY: event.clientY, panX: state.panX, panY: state.panY };
    viewport.classList.add('panning');
    state.selected = null;
    renderInspector();
    for (const el of world.children) el.classList.remove('selected');
  }
  viewport.setPointerCapture(event.pointerId);
});
viewport.addEventListener('pointermove', event => {
  if (!gesture) return;
  if (gesture.kind === 'pan') {
    state.panX = gesture.panX + event.clientX - gesture.startX;
    state.panY = gesture.panY + event.clientY - gesture.startY;
    setTransform();
  } else {
    const item = state.items.find(x => x.localId === gesture.id);
    if (!item) return;
    item.x = Math.round(gesture.itemX + (event.clientX - gesture.startX) / state.zoom);
    item.y = Math.round(gesture.itemY + (event.clientY - gesture.startY) / state.zoom);
    const el = [...world.children].find(x => x.dataset.id === item.localId);
    if (el) { el.style.left = item.x + 'px'; el.style.top = item.y + 'px'; }
    renderConnections();
    save();
  }
});
for (const name of ['pointerup', 'pointercancel']) viewport.addEventListener(name, () => { gesture = null; viewport.classList.remove('panning'); });
viewport.addEventListener('wheel', event => { event.preventDefault(); zoomAt(event.clientX, event.clientY, state.zoom * (event.deltaY < 0 ? 1.1 : 1 / 1.1)); }, { passive: false });
$('generateForm').addEventListener('submit', generate);
function isFeishuLink(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && /(^|\.)(feishu\.cn|feishucdn\.com|larksuite\.com|larksuitecdn\.com|larkoffice\.com)$/.test(url.hostname.toLowerCase());
  } catch { return false; }
}

async function fileFromClipboard(event) {
  const imageItem = [...(event.clipboardData?.items || [])].find(item => item.kind === 'file' && item.type.startsWith('image/'));
  const file = imageItem?.getAsFile();
  if (file) return file;
  const html = event.clipboardData?.getData('text/html') || '';
  const plain = event.clipboardData?.getData('text/plain')?.trim() || '';
  const embedded = html ? new DOMParser().parseFromString(html, 'text/html').querySelector('img')?.getAttribute('src') : null;
  const src = embedded || (isFeishuLink(plain) ? plain : null);
  const dataUri = src?.startsWith('data:image/') ? src : event.clipboardData?.getData('text/plain')?.startsWith('data:image/') ? event.clipboardData.getData('text/plain') : null;
  if (dataUri) {
    const blob = await (await fetch(dataUri)).blob();
    return new File([blob], 'pasted-image.png', { type: blob.type });
  }
  if (src) {
    try {
      const url = new URL(src);
      if (isFeishuLink(src)) {
        const response = await fetch(src, { credentials: 'include' });
        if (response.ok) {
          const blob = await response.blob();
          if (blob.type.startsWith('image/')) return new File([blob], 'feishu-image.png', { type: blob.type });
        }
      }
    } catch {}
    showToast('飞书只提供了受权限保护的图片链接；请在飞书中“复制图片”，或下载后上传');
  }
  return null;
}

document.addEventListener('paste', async event => {
  const items = [...(event.clipboardData?.items || [])];
  const html = event.clipboardData?.getData('text/html') || '';
  const plain = event.clipboardData?.getData('text/plain')?.trim() || '';
  if (!items.some(item => item.kind === 'file' && item.type.startsWith('image/')) && !/<img\b/i.test(html) && !plain.startsWith('data:image/') && !isFeishuLink(plain)) return;
  event.preventDefault();
  try {
    const file = await fileFromClipboard(event);
    if (file) importImage(file);
  } catch (error) {
    showToast('粘贴图片失败：' + error.message);
  }
});
$('uploadImageButton').addEventListener('click', () => $('uploadImageInput').click());
$('uploadImageInput').addEventListener('change', event => {
  const file = event.target.files?.[0];
  if (file) importImage(file);
  event.target.value = '';
});
world.addEventListener('click', event => {
  const modelButton = event.target.closest('.card-model-button');
  if (modelButton) {
    const item = state.items.find(x => x.localId === modelButton.closest('.image-card').dataset.id);
    if (item) openModelFor(item);
    return;
  }
  const button = event.target.closest('.card-edit-button');
  if (!button) return;
  const item = state.items.find(x => x.localId === button.closest('.image-card').dataset.id);
  if (item) { setEditSource(item); promptInput.focus(); }
});
$('editButton').addEventListener('click', () => {
  const item = state.items.find(x => x.localId === state.selected);
  if (item?.status === 'completed') { setEditSource(item); promptInput.focus(); }
});
$('clearSource').addEventListener('click', () => setEditSource(null));
$('modelButton').addEventListener('click', () => openModelFor(state.items.find(item => item.localId === state.selected)));
$('closeModel').addEventListener('click', hideModel);
$('modelBackdrop').addEventListener('click', hideModel);
$('modelViewer').addEventListener('error', () => { $('modelStatus').textContent = '模型预览失败，可下载 GLB 文件检查'; });
window.addEventListener('keydown', event => { if (event.key === 'Escape' && activeModelTaskId) hideModel(); });
$('zoomIn').addEventListener('click', () => { const r = viewport.getBoundingClientRect(); zoomAt(r.left + r.width / 2, r.top + r.height / 2, state.zoom * 1.2); });
$('zoomOut').addEventListener('click', () => { const r = viewport.getBoundingClientRect(); zoomAt(r.left + r.width / 2, r.top + r.height / 2, state.zoom / 1.2); });
$('fitButton').addEventListener('click', fit);
$('homeButton').addEventListener('click', fit);
$('deleteButton').addEventListener('click', () => {
  const id = state.selected;
  if (!id) return;
  clearTimeout(pollTimers.get(id));
  state.items = state.items.filter(x => x.localId !== id);
  if (editSourceId === id) setEditSource(null);
  state.selected = null;
  render();
  showToast('已从画布移除');
});
for (const chip of document.querySelectorAll('.prompt-chip')) chip.addEventListener('click', () => { promptInput.value = chip.dataset.prompt; promptInput.focus(); });
$('resolution').addEventListener('change', updatePrice);
$('modelSelect').addEventListener('change', updateModel);
promptInput.addEventListener('keydown', event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) $('generateForm').requestSubmit(); });
window.addEventListener('keydown', event => { if ((event.key === 'Delete' || event.key === 'Backspace') && state.selected && !['TEXTAREA', 'INPUT'].includes(document.activeElement.tagName)) $('deleteButton').click(); });
try { const savedModel = localStorage.getItem(modelStorageKey); if (modelCatalog.some(model => model.id === savedModel)) $('modelSelect').value = savedModel; } catch {}
updateModel();
restore();
setTransform();
render();
api('/api/config').then(config => {
  const el = $('apiStatus');
  if (!Array.isArray(config.models) || config.apiVersion < 5 || !config.features?.models3d) {
    el.querySelector('span:last-child').textContent = '本地服务为旧版本，请重启';
    el.classList.remove('ready');
    showToast('当前端口仍在运行旧版服务；请关闭旧终端并重新运行 npm start');
    return;
  }
  modelCatalog = config.models;
  model3dConfigured = config.model3dConfigured;
  updateModel();
  el.querySelector('span:last-child').textContent = config.mock ? '演示模式 · 不消耗额度' : config.configured ? (config.model3dConfigured ? 'WaveSpeed 已配置 · Meshy 可用' : 'WaveSpeed 已配置 · 3D 不可用') : '等待配置 WaveSpeed API';
  el.classList.toggle('ready', config.configured);
}).catch(() => $('apiStatus').querySelector('span:last-child').textContent = '本地服务连接失败');
for (const item of state.items) if (item.id && !['completed', 'failed', 'cancelled', 'timeout', 'deleted'].includes(item.status)) poll(item);
if (needsHydration) api('/api/generations').then(result => {
  if (state.items.length || !Array.isArray(result.items)) return;
  state.items = result.items.slice().reverse().map((task, index) => ({
    ...task, localId: task.id, x: 38 + (index % 3) * 330, y: 38 + Math.floor(index / 3) * 425
  }));
  if (state.items.length) { render(); fit(); }
  for (const item of state.items) if (item.id && !['completed', 'failed', 'cancelled', 'timeout', 'deleted'].includes(item.status)) poll(item);
}).catch(() => {});

api('/api/models').then(result => {
  if (!Array.isArray(result.items)) return;
  modelTasks = result.items;
  render();
  for (const task of modelTasks) if (!['completed', 'failed', 'cancelled', 'timeout', 'deleted'].includes(task.status)) pollModel(task);
}).catch(() => {});
