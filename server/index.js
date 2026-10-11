import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const publicDir = path.join(root, 'public');
const defaultDataDir = path.join(root, 'data');
const apiBase = 'https://api.wavespeed.ai/api/v3/';
const imageModels = {
  'nano-banana-2.1': {
    label: 'Nano Banana 2.1',
    path: 'google/nano-banana-2.1',
    prices: { '1k': 0.04, '2k': 0.06, '4k': 0.135 },
    referenceFee: 0.002,
    searchOptions: true
  },
  'nano-banana-2': {
    label: 'Nano Banana 2',
    path: 'google/nano-banana-2',
    prices: { '1k': 0.07, '2k': 0.105, '4k': 0.14 },
    referenceFee: 0,
    searchOptions: true
  },
  'nano-banana-pro': {
    label: 'Nano Banana Pro',
    path: 'google/nano-banana-pro',
    prices: { '1k': 0.14, '2k': 0.14, '4k': 0.24 },
    referenceFee: 0,
    searchOptions: false
  }
};
const defaultModelId = 'nano-banana-2.1';

const resultBase = 'https://api.wavespeed.ai/api/v3/predictions/';
const ratios = new Set(['1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16']);
const resolutions = new Set(['1k', '2k', '4k']);
const terminal = new Set(['failed', 'cancelled', 'timeout', 'deleted']);
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml' };

async function loadEnv() {
  try {
    const lines = (await readFile(path.join(root, '.env'), 'utf8')).split(/\r?\n/);
    for (const line of lines) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {}
}

function respond(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(body));
}

function message(error) {
  return error instanceof Error ? error.message : String(error);
}

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16384) throw new Error('请求内容过长');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('请求 JSON 格式不正确'); }
}

async function readImageBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 20 * 1024 * 1024) {
      const error = new Error('图片不能超过 20 MB');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function validImage(bytes, mime) {
  if (mime === 'image/png') return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mime === 'image/jpeg') return bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (mime === 'image/webp') return bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  return false;
}

function xmlEscape(value) {
  return value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
}

function mockImage(prompt) {
  const label = xmlEscape(prompt.slice(0, 46));
  return '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="#241a43"/><stop offset=".52" stop-color="#7351a7"/><stop offset="1" stop-color="#e2a980"/></linearGradient><radialGradient id="s"><stop stop-color="#ffe0aa" stop-opacity=".85"/><stop offset="1" stop-color="#ffe0aa" stop-opacity="0"/></radialGradient></defs><rect width="1024" height="1024" fill="url(#g)"/><circle cx="650" cy="420" r="360" fill="url(#s)"/><path d="M0 850Q180 640 340 770T680 705T1024 745V1024H0Z" fill="#1d1737" opacity=".7"/><circle cx="510" cy="370" r="145" fill="none" stroke="#f9ddbb" stroke-width="11" opacity=".75"/><path d="M510 170V570M310 370H710" stroke="#f9ddbb" stroke-width="5" opacity=".6"/><text x="50" y="908" fill="#fff" font-family="Arial" font-size="26">LOCAL PREVIEW</text><text x="50" y="952" fill="#fff" font-family="Arial" font-size="20">' + label + '</text></svg>';
}

async function downloadImage(fetchImpl, output, id, imageDir) {
  const raw = typeof output === 'string' ? output : output?.url || output?.image_url;
  if (!raw) throw new Error('WaveSpeed 未返回图片地址');
  const url = new URL(raw);
  if (url.protocol !== 'https:') throw new Error('图片地址必须使用 HTTPS');
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error('下载生成图片失败：' + response.status);
  const mime = (response.headers.get('content-type') || '').split(';')[0];
  const ext = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' }[mime];
  if (!ext) throw new Error('WaveSpeed 返回了不支持的图片格式');
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > 20 * 1024 * 1024) { await reader.cancel(); throw new Error('生成图片超过 20 MB'); }
    chunks.push(value);
  }
  const file = id + ext;
  await writeFile(path.join(imageDir, file), Buffer.concat(chunks));
  return '/api/images/' + file;
}

async function uploadReference(fetchImpl, key, source, imageDir) {
  const filename = source.imageUrl?.split('/').pop();
  if (!filename || !/^[a-zA-Z0-9-]+\.(png|jpg|webp)$/.test(filename)) {
    throw new Error('参考图格式不支持，请选择 WaveSpeed 生成的 PNG/JPEG/WebP 图片');
  }
  const bytes = await readFile(path.join(imageDir, filename));
  const mime = types[path.extname(filename)];
  const ticketResponse = await fetchImpl('https://api.wavespeed.ai/api/v3/media/uploads', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename, size: bytes.length, content_type: mime }),
    signal: AbortSignal.timeout(30000)
  });
  const ticketPayload = await ticketResponse.json().catch(() => ({}));
  const ticket = ticketPayload.data;
  if (!ticketResponse.ok || !ticket?.upload?.url || !ticket?.download_url) {
    throw new Error(ticketPayload.message || '参考图上传初始化失败：' + ticketResponse.status);
  }
  const uploadUrl = new URL(ticket.upload.url);
  if (uploadUrl.protocol !== 'https:') throw new Error('参考图上传地址必须使用 HTTPS');
  const uploadResponse = await fetchImpl(uploadUrl, {
    method: ticket.upload.method || 'PUT',
    headers: ticket.upload.headers || {},
    body: bytes,
    signal: AbortSignal.timeout(60000)
  });
  if (!uploadResponse.ok) throw new Error('参考图上传失败：' + uploadResponse.status);
  return ticket.download_url;
}

function mockGlb() {
  const positions = new Float32Array([0, 1, 0, -1, -0.6, 1, 1, -0.6, 1, 0, -0.6, -1]);
  const indices = new Uint16Array([0, 1, 2, 0, 2, 3, 0, 3, 1, 1, 3, 2]);
  const binary = Buffer.alloc(positions.byteLength + indices.byteLength);
  Buffer.from(positions.buffer).copy(binary, 0);
  Buffer.from(indices.buffer).copy(binary, positions.byteLength);
  const gltf = {
    asset: { version: '2.0', generator: 'ArtPlatform mock' },
    scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }],
    materials: [{ doubleSided: true, pbrMetallicRoughness: { baseColorFactor: [0.82, 0.58, 0.39, 1], metallicFactor: 0, roughnessFactor: 0.8 } }],
    buffers: [{ byteLength: binary.length }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: positions.byteLength, target: 34962 }, { buffer: 0, byteOffset: positions.byteLength, byteLength: indices.byteLength, target: 34963 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 4, type: 'VEC3', min: [-1, -0.6, -1], max: [1, 1, 1] }, { bufferView: 1, componentType: 5123, count: 12, type: 'SCALAR' }]
  };
  const json = Buffer.from(JSON.stringify(gltf));
  const jsonSize = Math.ceil(json.length / 4) * 4;
  const total = 12 + 8 + jsonSize + 8 + binary.length;
  const output = Buffer.alloc(total);
  output.write('glTF', 0);
  output.writeUInt32LE(2, 4);
  output.writeUInt32LE(total, 8);
  output.writeUInt32LE(jsonSize, 12);
  output.write('JSON', 16);
  json.copy(output, 20);
  output.fill(0x20, 20 + json.length, 20 + jsonSize);
  const binHeader = 20 + jsonSize;
  output.writeUInt32LE(binary.length, binHeader);
  output.write('BIN\0', binHeader + 4, 'ascii');
  binary.copy(output, binHeader + 8);
  return output;
}

function modelOutput(outputs) {
  for (const value of outputs || []) {
    const candidates = typeof value === 'string' ? [value] : [value?.url, value?.glb, value?.model_url, value?.model_glb?.url];
    for (const candidate of candidates) {
      if (typeof candidate !== 'string') continue;
      try { if (new URL(candidate).pathname.toLowerCase().endsWith('.glb')) return candidate; } catch {}
    }
  }
  return null;
}

async function downloadModel(fetchImpl, outputs, id, modelDir) {
  const raw = modelOutput(outputs);
  if (!raw) throw new Error('Hunyuan3D 未返回可预览的 GLB 文件');
  const url = new URL(raw);
  if (url.protocol !== 'https:') throw new Error('模型下载地址必须使用 HTTPS');
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error('下载 3D 模型失败：' + response.status);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > 100 * 1024 * 1024) { await reader.cancel(); throw new Error('3D 模型超过 100 MB'); }
    chunks.push(value);
  }
  const bytes = Buffer.concat(chunks);
  if (bytes.length < 20 || bytes.toString('ascii', 0, 4) !== 'glTF' || bytes.readUInt32LE(4) !== 2 || bytes.readUInt32LE(8) !== bytes.length) {
    throw new Error('Hunyuan3D 返回的文件不是有效的 GLB');
  }
  await writeFile(path.join(modelDir, id + '.glb'), bytes);
  return '/api/models/files/' + id + '.glb';
}

export async function createApp(options = {}) {
  await loadEnv();
  const dataDir = options.dataDir ?? defaultDataDir;
  const imageDir = path.join(dataDir, 'images');
  const taskFile = path.join(dataDir, 'tasks.json');
  const modelDir = path.join(dataDir, 'models');
  const modelTaskFile = path.join(dataDir, 'model-tasks.json');
  await mkdir(imageDir, { recursive: true });
  await mkdir(modelDir, { recursive: true });
  const key = options.apiKey ?? process.env.WAVESPEED_API_KEY ?? '';
  const mock = options.mock ?? process.env.WAVESPEED_MOCK === '1';
  const fetchImpl = options.fetchImpl ?? fetch;
  let tasks = {};
  try { tasks = JSON.parse(await readFile(taskFile, 'utf8')); } catch {}
  const persist = () => writeFile(taskFile, JSON.stringify(tasks, null, 2));
  let modelTasks = {};
  try { modelTasks = JSON.parse(await readFile(modelTaskFile, 'utf8')); } catch {}
  const persistModels = () => writeFile(modelTaskFile, JSON.stringify(modelTasks, null, 2));
  let legacyChanged = false;
  for (const task of Object.values(modelTasks)) {
    if (task.provider !== 'wavespeed-meshy-v7.1' && task.status !== 'completed' && !terminal.has(task.status)) {
      task.status = 'failed';
      task.error = '旧 3D 任务已停用，请使用 WaveSpeed Meshy 重新生成';
      legacyChanged = true;
    }
  }
  if (legacyChanged) await persistModels();

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const pathname = url.pathname;
      if (req.method === 'GET' && pathname === '/api/config') {
        return respond(res, 200, { configured: Boolean(key) || mock, mock, apiVersion: 5, features: { models3d: true }, model3dProvider: 'wavespeed-meshy-v7.1', model3dConfigured: Boolean(key) || mock, defaultModelId, models: Object.entries(imageModels).map(([id, value]) => ({ id, label: value.label, prices: value.prices, referenceFee: value.referenceFee })) });
      }
      if (req.method === 'GET' && pathname === '/api/generations') {
        return respond(res, 200, { items: Object.values(tasks).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100) });
      }
      if (req.method === 'POST' && pathname === '/api/imports') {
        const origin = req.headers.origin;
        if (origin && new URL(origin).host !== req.headers.host) return respond(res, 403, { error: '只允许从本地页面导入' });
        const mime = String(req.headers['content-type'] || '').split(';')[0].toLowerCase();
        const ext = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' }[mime];
        if (!ext) return respond(res, 415, { error: '仅支持 PNG、JPEG 或 WebP 图片' });
        const bytes = await readImageBody(req);
        if (!validImage(bytes, mime)) return respond(res, 400, { error: '图片内容与格式不匹配' });
        const id = crypto.randomUUID();
        const filename = id + ext;
        await writeFile(path.join(imageDir, filename), bytes);
        const task = { id, prompt: '本地参考图片', aspectRatio: '1:1', resolution: 'original', mode: 'import', sourceTaskId: null, status: 'completed', imageUrl: '/api/images/' + filename, createdAt: new Date().toISOString(), error: null };
        tasks[id] = task;
        await persist();
        return respond(res, 201, { task });
      }
      if (req.method === 'POST' && pathname === '/api/generations') {
        const origin = req.headers.origin;
        if (origin && new URL(origin).host !== req.headers.host) return respond(res, 403, { error: '只允许从本地页面提交' });
        const body = await readBody(req);
        const prompt = String(body.prompt || '').trim();
        const ratio = String(body.aspectRatio || '1:1');
        const resolution = String(body.resolution || '1k');
        const modelId = String(body.modelId || defaultModelId);
        const model = imageModels[modelId];
        const sourceTaskId = body.sourceTaskId ? String(body.sourceTaskId) : null;
        const source = sourceTaskId ? tasks[sourceTaskId] : null;
        if (!prompt || prompt.length > 2000) return respond(res, 400, { error: '请输入 1–2000 字的描述' });
        if (!ratios.has(ratio) || !resolutions.has(resolution)) return respond(res, 400, { error: '不支持的尺寸或分辨率' });
        if (!model) return respond(res, 400, { error: '不支持的生图模型' });
        if (sourceTaskId && (!source || source.status !== 'completed' || !source.imageUrl)) return respond(res, 400, { error: '请选择一张已完成的参考图片' });
        if (!key && !mock) return respond(res, 503, { error: '请先在 .env 中配置 WAVESPEED_API_KEY，然后重启服务' });
        let id;
        let status = 'submitted';
        let imageUrl = null;
        if (mock) {
          id = crypto.randomUUID();
          const file = id + '.svg';
          await writeFile(path.join(imageDir, file), mockImage(source ? '编辑：' + prompt : prompt));
          imageUrl = '/api/images/' + file;
          status = 'completed';
        } else {
          const inputUrl = source ? await uploadReference(fetchImpl, key, source, imageDir) : null;
          const endpoint = apiBase + model.path + (source ? '/edit' : '/text-to-image');
          const upstream = await fetchImpl(endpoint, {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt, ...(inputUrl ? { images: [inputUrl] } : {}), aspect_ratio: ratio, resolution, ...(model.searchOptions ? { enable_web_search: false, enable_image_search: false } : {}), output_format: 'png' }),
            signal: AbortSignal.timeout(30000)
          });
          const payload = await upstream.json().catch(() => ({}));
          if (!upstream.ok || !payload.data?.id) throw new Error(payload.message || payload.data?.error || 'WaveSpeed 提交失败：' + upstream.status);
          id = payload.data.id;
          status = payload.data.status || 'submitted';
        }
        const task = { id, prompt, aspectRatio: ratio, resolution, modelId, mode: source ? 'edit' : 'create', sourceTaskId, status, imageUrl, createdAt: new Date().toISOString(), error: null };
        tasks[id] = task;
        await persist();
        return respond(res, 201, { task });
      }
      if (req.method === 'GET' && pathname === '/api/models') {
        return respond(res, 200, { items: Object.values(modelTasks).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100) });
      }
      if (req.method === 'POST' && pathname === '/api/models') {
        const origin = req.headers.origin;
        if (origin && new URL(origin).host !== req.headers.host) return respond(res, 403, { error: '只允许从本地页面提交' });
        const body = await readBody(req);
        const sourceTaskId = String(body.sourceTaskId || '');
        const source = tasks[sourceTaskId];
        const generateType = String(body.generateType || 'Normal');
        if (!source || source.status !== 'completed' || !source.imageUrl) return respond(res, 400, { error: '请选择一张已完成的图片' });
        if (!['Normal', 'LowPoly', 'Geometry'].includes(generateType)) return respond(res, 400, { error: '不支持的 3D 生成模式' });
        if (!key && !mock) return respond(res, 503, { error: '请先在 .env 中配置 WAVESPEED_API_KEY，然后重启服务' });
        let id;
        let status = 'pending';
        let modelUrl = null;
        if (mock) {
          id = crypto.randomUUID();
          await writeFile(path.join(modelDir, id + '.glb'), mockGlb());
          modelUrl = '/api/models/files/' + id + '.glb';
          status = 'completed';
        } else {
          const imageUrl = await uploadReference(fetchImpl, key, source, imageDir);
          const textured = generateType !== 'Geometry';
          const upstream = await fetchImpl(apiBase + 'meshy/v7.1/image-to-3d', {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              image: imageUrl,
              model_type: 'standard',
              topology: 'triangle',
              target_polycount: generateType === 'LowPoly' ? 5000 : 30000,
              symmetry_mode: 'auto',
              should_remesh: true,
              should_texture: textured,
              enable_pbr: false,
              geometry_resolution: 'standard',
              enable_rigging: false,
              enable_animation: false
            }),
            signal: AbortSignal.timeout(30000)
          });
          const payload = await upstream.json().catch(() => ({}));
          if (!upstream.ok || !payload.data?.id) throw new Error(payload.message || payload.data?.error || 'WaveSpeed Meshy 提交失败：' + upstream.status);
          id = payload.data.id;
          status = payload.data.status || 'pending';
        }
        const task = { id, sourceTaskId, provider: 'wavespeed-meshy-v7.1', generateType, status, progress: status === 'completed' ? 100 : null, modelUrl, createdAt: new Date().toISOString(), error: null };
        modelTasks[id] = task;
        await persistModels();
        return respond(res, 201, { task });
      }
      const modelMatch = pathname.match(/^\/api\/models\/([a-zA-Z0-9-]+)$/);
      if (req.method === 'GET' && modelMatch) {
        const task = modelTasks[modelMatch[1]];
        if (!task) return respond(res, 404, { error: '3D 任务不存在' });
        if (!mock && task.status !== 'completed' && !terminal.has(task.status)) {
          const upstream = await fetchImpl(resultBase + encodeURIComponent(task.id) + '/result', {
            headers: { 'Authorization': 'Bearer ' + key },
            signal: AbortSignal.timeout(30000)
          });
          const payload = await upstream.json().catch(() => ({}));
          if (!upstream.ok || !payload.data) throw new Error(payload.message || 'WaveSpeed Meshy 查询失败：' + upstream.status);
          task.status = payload.data.status || 'processing';
          if (Number.isFinite(payload.data.progress)) task.progress = payload.data.progress;
          if (task.status === 'completed') {
            try { task.modelUrl = await downloadModel(fetchImpl, payload.data.outputs, task.id, modelDir); }
            catch (error) { task.status = 'failed'; task.error = message(error); }
          } else if (terminal.has(task.status)) task.error = payload.data.error || '3D 生成失败';
          await persistModels();
        }
        return respond(res, 200, { task });
      }
      const modelFile = pathname.match(/^\/api\/models\/files\/([a-zA-Z0-9-]+\.glb)$/);
      if (req.method === 'GET' && modelFile) {
        const content = await readFile(path.join(modelDir, modelFile[1]));
        res.writeHead(200, { 'Content-Type': 'model/gltf-binary', 'Content-Length': content.length, 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' });
        return res.end(content);
      }
      const match = pathname.match(/^\/api\/generations\/([a-zA-Z0-9-]+)$/);
      if (req.method === 'GET' && match) {
        const task = tasks[match[1]];
        if (!task) return respond(res, 404, { error: '任务不存在' });
        if (!mock && task.status !== 'completed' && !terminal.has(task.status)) {
          const upstream = await fetchImpl(resultBase + encodeURIComponent(task.id) + '/result', {
            headers: { 'Authorization': 'Bearer ' + key },
            signal: AbortSignal.timeout(30000)
          });
          const payload = await upstream.json().catch(() => ({}));
          if (!upstream.ok || !payload.data) throw new Error(payload.message || 'WaveSpeed 查询失败：' + upstream.status);
          task.status = payload.data.status || 'processing';
          if (task.status === 'completed') {
            try { task.imageUrl = await downloadImage(fetchImpl, payload.data.outputs?.[0], task.id, imageDir); }
            catch (error) { task.status = 'failed'; task.error = message(error); }
          } else if (terminal.has(task.status)) {
            task.error = payload.data.error || '生成失败';
          }
          await persist();
        }
        return respond(res, 200, { task });
      }
      const image = pathname.match(/^\/api\/images\/([a-zA-Z0-9-]+\.(?:png|jpg|webp|svg))$/);
      if (req.method === 'GET' && image) {
        const filename = image[1];
        const content = await readFile(path.join(imageDir, filename));
        res.writeHead(200, { 'Content-Type': types[path.extname(filename)], 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' });
        return res.end(content);
      }
      const staticFiles = { '/': 'index.html', '/app.js': 'app.js', '/styles.css': 'styles.css' };
      if (req.method === 'GET' && staticFiles[pathname]) {
        const file = staticFiles[pathname];
        const content = await readFile(path.join(publicDir, file));
        res.writeHead(200, { 'Content-Type': types[path.extname(file)], 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
        return res.end(content);
      }
      return respond(res, 404, { error: '未找到资源' });
    } catch (error) {
      return respond(res, error.status || 500, { error: message(error) });
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = await createApp();
  const port = Number(process.env.PORT || 4173);
  app.listen(port, '127.0.0.1', () => console.log('ArtPlatform: http://127.0.0.1:' + port));
}
