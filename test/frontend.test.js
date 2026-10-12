import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/index.js';

// A small DOM harness runs the actual UI against the local mock server, without a browser dependency.
class Element {
  constructor(tagName = 'DIV') {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.style = {};
    this.dataset = {};
    this.listeners = {};
    this.value = '';
    this.textContent = '';
    const classes = new Set();
    this.classList = {
      add: value => classes.add(value), remove: value => classes.delete(value),
      toggle: (value, enabled) => enabled ? classes.add(value) : classes.delete(value),
      contains: value => classes.has(value)
    };
  }
  get options() { return this.children.flatMap(child => child.tagName === 'OPTGROUP' ? child.children : [child]); }
  replaceChildren(...children) { this.children = children; }
  append(...children) { this.children.push(...children); }
  setAttribute(name, value) { this[name] = value; }
  removeAttribute(name) { delete this[name]; }
  addEventListener(name, callback) { (this.listeners[name] ||= []).push(callback); }
  async dispatch(name, event = {}) { for (const callback of this.listeners[name] || []) await callback(event); }
  querySelector() { return this.statusChild ||= new Element(); }
  getBoundingClientRect() { return { width: 1000, height: 800, left: 0, top: 0 }; }
  focus() {}
}
class Option extends Element {
  constructor(label, value) { super('OPTION'); this.textContent = label; this.value = value; }
}

test('UI restores a GPT choice, adapts controls, submits quality, and switches back to Nano Banana', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'artplatform-ui-'));
  const app = await createApp({ dataDir, mock: true, apiKey: '' });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => app.close(resolve)); await rm(dataDir, { recursive: true, force: true }); });
  const base = 'http://127.0.0.1:' + app.address().port;
  const html = await (await fetch(base + '/')).text();
  const elements = new Map();
  for (const match of html.matchAll(/<(\w+)[^>]*\bid="([^"]+)"[^>]*>/g)) {
    const element = new Element(match[1]);
    element.disabled = /\bdisabled\b/.test(match[0]);
    elements.set(match[2], element);
  }
  for (const match of html.matchAll(/<select\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) {
    const select = elements.get(match[1]);
    for (const option of match[2].matchAll(/<option(?: value="([^"]+)")?>([^<]+)<\/option>/g)) select.append(new Option(option[2], option[1] || option[2]));
    select.value = select.options[0]?.value || '';
  }
  const stored = new Map([['artplatform-model', 'gpt-image-1.5'], ['artplatform-board-v1', '{"items":[]}']]);
  const requests = [];
  const context = vm.createContext({
    document: {
      documentElement: { dataset: { theme: 'dark' } }, activeElement: new Element(),
      getElementById: id => { assert.ok(elements.has(id), 'missing HTML element: ' + id); return elements.get(id); },
      createElement: tag => new Element(tag), createElementNS: (_, tag) => new Element(tag),
      querySelector: () => new Element(), querySelectorAll: () => [], addEventListener() {}
    },
    window: { addEventListener() {} }, Option, Image: Element, crypto: { randomUUID },
    localStorage: { getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value) },
    fetch: (url, options) => { requests.push({ url, options }); return fetch(base + url, options); },
    setTimeout: (fn, ms) => setTimeout(fn, ms).unref(), clearTimeout,
    customElements: { get() {} }, console
  });
  vm.runInContext(await readFile(new URL('../public/app.js', import.meta.url), 'utf8'), context);
  for (let i = 0; i < 100 && elements.get('generateButton').disabled; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(elements.get('generateButton').disabled, false);
  const model = elements.get('modelSelect');
  assert.equal(model.options.length, 7);
  assert.equal(model.value, 'gpt-image-1.5');
  assert.equal(elements.get('resolution').disabled, true);
  assert.equal(elements.get('ratio').options.map(x => x.value).join(','), '1:1,3:2,2:3');
  assert.equal(elements.get('qualitySelect').value, 'medium');
  assert.equal(elements.get('price').textContent, '约 $0.04 / 张');

  model.value = 'gpt-image-2.5-flare';
  await model.dispatch('change');
  assert.equal(elements.get('resolution').disabled, false);
  assert.equal(elements.get('qualitySelect').options.length, 5);
  elements.get('resolution').value = '2k';
  elements.get('qualitySelect').value = 'max';
  await elements.get('qualitySelect').dispatch('change');
  assert.equal(elements.get('price').textContent, '约 $0.60 / 张');
  elements.get('prompt').value = '魔法森林入口';
  await elements.get('generateForm').dispatch('submit', { preventDefault() {} });
  const submitted = requests.find(request => request.options?.method === 'POST');
  assert.deepEqual(JSON.parse(submitted.options.body), { prompt: '魔法森林入口', aspectRatio: '1:1', resolution: '2k', quality: 'max', modelId: 'gpt-image-2.5-flare', sourceTaskId: null });
  const card = vm.runInContext('state.items[0]', context);
  assert.equal(card.status, 'completed');
  assert.equal(card.quality, 'max');
  assert.equal(card.modelId, 'gpt-image-2.5-flare');

  model.value = 'nano-banana-2.1';
  await model.dispatch('change');
  assert.equal(elements.get('qualityControl').classList.contains('hidden'), true);
  assert.equal(elements.get('price').textContent, '约 $0.06 / 张');
  assert.equal(stored.get('artplatform-model'), 'nano-banana-2.1');
});
