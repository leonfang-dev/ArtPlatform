import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/index.js';

async function fixture(t, options) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'artplatform-test-'));
  const app = await createApp({ dataDir, ...options });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => app.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  });
  return 'http://127.0.0.1:' + app.address().port;
}

test('mock mode creates a local image without an API key', async t => {
  const base = await fixture(t, { mock: true, apiKey: '' });
  const page = await fetch(base + '/');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /创作画布/);
  const script = await fetch(base + '/app.js');
  assert.equal(script.status, 200);
  const config = await (await fetch(base + '/api/config')).json();
  assert.equal(config.mock, true);
  const response = await fetch(base + '/api/generations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: '发光的石门', aspectRatio: '1:1', resolution: '1k' }) });
  assert.equal(response.status, 201);
  const { task } = await response.json();
  assert.equal(task.status, 'completed');
  const image = await fetch(base + task.imageUrl);
  assert.equal(image.status, 200);
  assert.match(await image.text(), /发光的石门/);
});

test('WaveSpeed submission and result use the documented API contract', async t => {
  const calls = [];
  const fakeFetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith('/text-to-image')) return Response.json({ data: { id: 'prediction-123', status: 'pending' } });
    if (String(url).endsWith('/result')) return Response.json({ data: { status: 'completed', outputs: ['https://cdn.example/image.png'] } });
    return new Response(Buffer.from('image-bytes'), { headers: { 'content-type': 'image/png' } });
  };
  const base = await fixture(t, { mock: false, apiKey: 'test-key', fetchImpl: fakeFetch });
  const response = await fetch(base + '/api/generations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: '水晶路灯', aspectRatio: '3:2', resolution: '2k' }) });
  assert.equal(response.status, 201);
  const submitted = await response.json();
  assert.equal(submitted.task.id, 'prediction-123');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer test-key');
  assert.deepEqual(JSON.parse(calls[0].options.body), { prompt: '水晶路灯', aspect_ratio: '3:2', resolution: '2k', enable_web_search: false, enable_image_search: false, output_format: 'png' });
  const result = await (await fetch(base + '/api/generations/prediction-123')).json();
  assert.equal(result.task.status, 'completed');
  assert.equal(result.task.imageUrl, '/api/images/prediction-123.png');
  assert.equal((await fetch(base + result.task.imageUrl)).status, 200);
  assert.equal(calls.length, 3);
});

test('invalid prompts are rejected before billing', async t => {
  const base = await fixture(t, { mock: true });
  const response = await fetch(base + '/api/generations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: ' ', aspectRatio: '1:1', resolution: '1k' }) });
  assert.equal(response.status, 400);
});

test('an existing generated image can be edited as a new card', async t => {
  const base = await fixture(t, { mock: true, apiKey: '' });
  const create = await (await fetch(base + '/api/generations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: '原始石门', aspectRatio: '1:1', resolution: '1k' }) })).json();
  const editResponse = await fetch(base + '/api/generations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: '改成金色符文，保持石门形状', sourceTaskId: create.task.id, aspectRatio: '1:1', resolution: '1k' }) });
  assert.equal(editResponse.status, 201);
  const edited = (await editResponse.json()).task;
  assert.equal(edited.mode, 'edit');
  assert.equal(edited.sourceTaskId, create.task.id);
  assert.notEqual(edited.imageUrl, create.task.imageUrl);
  assert.equal((await fetch(base + create.task.imageUrl)).status, 200);
  assert.equal((await fetch(base + edited.imageUrl)).status, 200);
});

test('real edit uploads the local reference and sends its WaveSpeed URL', async t => {
  const calls = [];
  const fakeFetch = async (url, options = {}) => {
    const u = String(url);
    calls.push({ url: u, options });
    if (u.endsWith('/text-to-image')) return Response.json({ data: { id: 'source-123', status: 'pending' } });
    if (u.endsWith('/media/uploads')) return Response.json({ data: { download_url: 'https://media.example/reference.png', upload: { method: 'PUT', url: 'https://storage.example/signed', headers: { 'Content-Type': 'image/png' } } } });
    if (u.includes('storage.example')) return new Response('', { status: 200 });
    if (u.endsWith('/edit')) return Response.json({ data: { id: 'edit-456', status: 'pending' } });
    if (u.endsWith('/result')) return Response.json({ data: { status: 'completed', outputs: ['https://cdn.example/image.png'] } });
    return new Response(Buffer.from('image-bytes'), { headers: { 'content-type': 'image/png' } });
  };
  const base = await fixture(t, { mock: false, apiKey: 'test-key', fetchImpl: fakeFetch });
  await fetch(base + '/api/generations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: '原图', aspectRatio: '1:1', resolution: '1k' }) });
  await fetch(base + '/api/generations/source-123');
  const response = await fetch(base + '/api/generations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: '改成夜景', modelId: 'nano-banana-2', sourceTaskId: 'source-123', aspectRatio: '1:1', resolution: '1k' }) });
  assert.equal(response.status, 201);
  const ticket = calls.find(x => x.url.endsWith('/media/uploads'));
  const upload = calls.find(x => x.url.includes('storage.example'));
  const edit = calls.find(x => x.url.endsWith('/edit'));
  assert.deepEqual(JSON.parse(ticket.options.body), { filename: 'source-123.png', size: 11, content_type: 'image/png' });
  assert.equal(ticket.options.headers.Authorization, 'Bearer test-key');
  assert.equal(upload.options.headers.Authorization, undefined);
  assert.deepEqual(JSON.parse(edit.options.body).images, ['https://media.example/reference.png']);
  assert.match(edit.url, /google\/nano-banana-2\/edit$/);
  assert.equal((await response.json()).task.sourceTaskId, 'source-123');
});

test('edit rejects unknown or unfinished source before upload', async t => {
  const base = await fixture(t, { mock: true });
  const response = await fetch(base + '/api/generations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: '修改', sourceTaskId: 'missing', aspectRatio: '1:1', resolution: '1k' }) });
  assert.equal(response.status, 400);
});

test('pasted local image can become an edit reference', async t => {
  const calls = [];
  const fakeFetch = async (url, options = {}) => {
    const u = String(url);
    calls.push({ url: u, options });
    if (u.endsWith('/media/uploads')) return Response.json({ data: { download_url: 'https://media.example/pasted.png', upload: { method: 'PUT', url: 'https://storage.example/signed', headers: { 'Content-Type': 'image/png' } } } });
    if (u.includes('storage.example')) return new Response('', { status: 200 });
    if (u.endsWith('/edit')) return Response.json({ data: { id: 'edited-paste-1', status: 'pending' } });
    throw new Error('unexpected URL: ' + u);
  };
  const base = await fixture(t, { mock: false, apiKey: 'test-key', fetchImpl: fakeFetch });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII=', 'base64');
  const importedResponse = await fetch(base + '/api/imports', { method: 'POST', headers: { 'content-type': 'image/png' }, body: png });
  assert.equal(importedResponse.status, 201);
  const imported = (await importedResponse.json()).task;
  assert.equal(imported.mode, 'import');
  assert.equal(imported.status, 'completed');
  assert.equal((await fetch(base + imported.imageUrl)).status, 200);
  const editResponse = await fetch(base + '/api/generations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: '换成蓝色背景', sourceTaskId: imported.id, aspectRatio: '1:1', resolution: '1k' }) });
  assert.equal(editResponse.status, 201);
  assert.equal((await editResponse.json()).task.sourceTaskId, imported.id);
  const edit = calls.find(x => x.url.endsWith('/edit'));
  assert.deepEqual(JSON.parse(edit.options.body).images, ['https://media.example/pasted.png']);
});

test('local import rejects wrong image content', async t => {
  const base = await fixture(t, { mock: true });
  const response = await fetch(base + '/api/imports', { method: 'POST', headers: { 'content-type': 'image/png' }, body: Buffer.from('not an image') });
  assert.equal(response.status, 400);
});

test('model selection routes only approved WaveSpeed models', async t => {
  const calls = [];
  const fakeFetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return Response.json({ data: { id: 'pro-123', status: 'pending' } });
  };
  const base = await fixture(t, { mock: false, apiKey: 'test-key', fetchImpl: fakeFetch });
  const config = await (await fetch(base + '/api/config')).json();
  assert.equal(config.defaultModelId, 'nano-banana-2.1');
  assert.equal(config.models.length, 3);
  const response = await fetch(base + '/api/generations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: '森林石门', modelId: 'nano-banana-pro', aspectRatio: '1:1', resolution: '2k' }) });
  assert.equal(response.status, 201);
  assert.match(calls[0].url, /google\/nano-banana-pro\/text-to-image$/);
  assert.equal(JSON.parse(calls[0].options.body).enable_web_search, undefined);
  assert.equal((await response.json()).task.modelId, 'nano-banana-pro');
  const invalid = await fetch(base + '/api/generations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: '森林石门', modelId: 'arbitrary/model', aspectRatio: '1:1', resolution: '1k' }) });
  assert.equal(invalid.status, 400);
  assert.equal(calls.length, 1);
});

test('mock WaveSpeed Meshy creates a viewable local GLB', async t => {
  const base = await fixture(t, { mock: true, apiKey: '' });
  const image = (await (await fetch(base + '/api/generations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: '石门', aspectRatio: '1:1', resolution: '1k' }) })).json()).task;
  const create = await fetch(base + '/api/models', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sourceTaskId: image.id, generateType: 'Normal' }) });
  assert.equal(create.status, 201);
  const model = (await create.json()).task;
  assert.equal(model.status, 'completed');
  assert.equal(model.provider, 'wavespeed-meshy-v7.1');
  assert.equal(model.sourceTaskId, image.id);
  const file = await fetch(base + model.modelUrl);
  assert.equal(file.status, 200);
  assert.match(file.headers.get('content-type'), /model\/gltf-binary/);
  const bytes = Buffer.from(await file.arrayBuffer());
  assert.equal(bytes.toString('ascii', 0, 4), 'glTF');
  assert.equal(bytes.readUInt32LE(8), bytes.length);
  const gltf = JSON.parse(bytes.toString('utf8', 20, 20 + bytes.readUInt32LE(12)).trim());
  assert.equal(gltf.asset.version, '2.0');
  assert.equal(gltf.meshes.length, 1);
  const listed = await (await fetch(base + '/api/models')).json();
  assert.equal(listed.items.length, 1);
});

test('WaveSpeed Meshy uploads a local image, polls status, and saves GLB', async t => {
  const mockBase = await fixture(t, { mock: true, apiKey: '' });
  const source = (await (await fetch(mockBase + '/api/generations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: '模型样本', aspectRatio: '1:1', resolution: '1k' }) })).json()).task;
  const mockModel = (await (await fetch(mockBase + '/api/models', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sourceTaskId: source.id }) })).json()).task;
  const glb = Buffer.from(await (await fetch(mockBase + mockModel.modelUrl)).arrayBuffer());
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII=', 'base64');
  const calls = [];
  let polls = 0;
  const fakeFetch = async (url, options = {}) => {
    const u = String(url);
    calls.push({ url: u, options });
    if (u.endsWith('/media/uploads')) return Response.json({ data: { download_url: 'https://media.example/source.png', upload: { method: 'PUT', url: 'https://storage.example/signed', headers: { 'Content-Type': 'image/png' } } } });
    if (u.includes('storage.example')) return new Response('', { status: 200 });
    if (u.endsWith('/meshy/v7.1/image-to-3d')) return Response.json({ data: { id: 'model-123', status: 'pending' } });
    if (u.endsWith('/predictions/model-123/result')) {
      polls++;
      return Response.json({ data: polls === 1 ? { status: 'processing', progress: 42 } : { status: 'completed', progress: 100, outputs: ['https://cdn.example/model.glb'] } });
    }
    if (u.endsWith('/model.glb')) return new Response(glb, { headers: { 'content-type': 'model/gltf-binary' } });
    throw new Error('unexpected URL: ' + u);
  };
  const base = await fixture(t, { mock: false, apiKey: 'wavespeed-key', fetchImpl: fakeFetch });
  const imported = (await (await fetch(base + '/api/imports', { method: 'POST', headers: { 'content-type': 'image/png' }, body: png })).json()).task;
  const create = await fetch(base + '/api/models', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sourceTaskId: imported.id, generateType: 'Normal' }) });
  assert.equal(create.status, 201);
  const request = calls.find(call => call.url.endsWith('/meshy/v7.1/image-to-3d'));
  assert.equal(request.options.headers.Authorization, 'Bearer wavespeed-key');
  assert.deepEqual(JSON.parse(request.options.body), {
    image: 'https://media.example/source.png', model_type: 'standard', topology: 'triangle',
    target_polycount: 30000, symmetry_mode: 'auto', should_remesh: true, should_texture: true,
    enable_pbr: false, geometry_resolution: 'standard', enable_rigging: false, enable_animation: false
  });
  const pending = (await (await fetch(base + '/api/models/model-123')).json()).task;
  assert.equal(pending.status, 'processing');
  assert.equal(pending.progress, 42);
  const result = (await (await fetch(base + '/api/models/model-123')).json()).task;
  assert.equal(result.status, 'completed');
  assert.equal(result.progress, 100);
  assert.equal((await fetch(base + result.modelUrl)).status, 200);
});

test('WaveSpeed Meshy rejects missing source or key before billing', async t => {
  const base = await fixture(t, { mock: true });
  const invalid = await fetch(base + '/api/models', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sourceTaskId: 'missing' }) });
  assert.equal(invalid.status, 400);
  const realBase = await fixture(t, { mock: false, apiKey: '' });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII=', 'base64');
  const imported = (await (await fetch(realBase + '/api/imports', { method: 'POST', headers: { 'content-type': 'image/png' }, body: png })).json()).task;
  const response = await fetch(realBase + '/api/models', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sourceTaskId: imported.id }) });
  assert.equal(response.status, 503);
});

test('stalled legacy 3D tasks are marked for regeneration', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'artplatform-legacy-'));
  await writeFile(path.join(dataDir, 'model-tasks.json'), JSON.stringify({ old: { id: 'old', sourceTaskId: 'image', status: 'processing', modelUrl: null, createdAt: new Date().toISOString(), error: null } }));
  const app = await createApp({ dataDir, mock: true, apiKey: '' });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => app.close(resolve)); await rm(dataDir, { recursive: true, force: true }); });
  const result = await (await fetch('http://127.0.0.1:' + app.address().port + '/api/models')).json();
  assert.equal(result.items[0].status, 'failed');
  assert.match(result.items[0].error, /重新生成/);
});
