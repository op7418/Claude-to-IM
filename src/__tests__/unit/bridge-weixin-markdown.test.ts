import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { markdownToWeixinText } from '../../lib/bridge/markdown/weixin';

describe('bridge weixin markdown renderer', () => {
  it('renders markdown tables as readable bullet lists', () => {
    const rendered = markdownToWeixinText(`
| 项目 | 评分 | 链接 |
| --- | --- | --- |
| DeepSeek R2 | 45 | [项目主页](https://example.com/deepseek-r2) |
`);

    assert.match(rendered, /【DeepSeek R2】/);
    assert.match(rendered, /- 评分: 45/);
    assert.match(rendered, /- 链接: 项目主页 \(https:\/\/example\.com\/deepseek-r2\)/);
  });

  it('keeps bare URLs visible without duplicating them', () => {
    const rendered = markdownToWeixinText('文档地址：https://example.com/docs');

    assert.equal(rendered, '文档地址：https://example.com/docs');
  });
});
