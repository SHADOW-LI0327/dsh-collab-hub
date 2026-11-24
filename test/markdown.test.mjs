import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../public/markdown.js', import.meta.url), 'utf8');
const sandbox = { window: {} };
vm.runInNewContext(source, sandbox);
const render = sandbox.window.renderMarkdown;

test('markdown: headings, lists, code, tables, links and safety', () => {
  assert.match(render('# Title\n\n- one\n- [x] done'), /<h1>Title<\/h1>/);
  assert.match(render('- [x] done'), /<input type="checkbox" disabled checked>/);
  assert.match(render('| A | B |\n| --- | ---: |\n| 1 | 2 |'), /<table>/);
  assert.match(render('| A | B |\n| --- | ---: |\n| 1 | 2 |'), /md-align-right/);
  assert.match(render('```js\nconst a = 1;\n```'), /language-js/);
  assert.match(render('**bold** and `code`'), /<strong>bold<\/strong>/);
  assert.match(render('**bold** and `code`'), /<code>code<\/code>/);
  assert.match(render('[site](https://example.com)'), /<a href="https:\/\/example.com"/);
  assert.doesNotMatch(render('[x](javascript:alert(1))'), /<a /);
  assert.match(render('<script>alert(1)</script>'), /&lt;script&gt;/);
  assert.match(render('![shot](https://example.com/a.png)'), /<img src="https:\/\/example.com\/a.png"/);
  assert.match(render('---\nid: X\n---\n# T'), /md-frontmatter/);
  assert.match(render('> quoted'), /<blockquote>/);
  assert.match(render('---'), /<hr>/);
});
