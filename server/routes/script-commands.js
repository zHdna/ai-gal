/**
 * STscript 扩展命令后端路由 (Phase 6: 扩展命令 /websearch)
 *
 * 免 key 联网搜索：通过 DuckDuckGo HTML 端点抓取 snippet，前端 /websearch 命令调用。
 * 失败时优雅降级（返回 degraded: true 与空结果），不抛出 500。
 *
 * Endpoints:
 *   GET /api/script/websearch?q=<query>&limit=5  -> { query, results: [{title, url, snippet}], degraded }
 */
const { Router } = require('express');

// 基础 HTML 实体解码（&, <, >, ", '）
function decodeEntities(str) {
  if (!str) return '';
  return String(str)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&apos;/g, "'");
}

// 去除标签，折叠空白
function stripHtml(str) {
  if (!str) return '';
  return decodeEntities(String(str).replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

async function duckduckgoSearch(query, limit) {
  const url = 'https://html.duckduckgo.com/html/';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      },
      body: 'q=' + encodeURIComponent(query),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error('DuckDuckGo 返回 ' + res.status);
    const html = await res.text();

    // 标题 + 链接：<a class="result__a" href="...">标题</a>
    const linkRe = /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    // 摘要：DuckDuckGo HTML 中摘要通常也是 <a class="result__snippet">...</a>
    const snipRe = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;

    const links = [];
    let m;
    while ((m = linkRe.exec(html)) !== null) {
      links.push({ url: m[1], title: stripHtml(m[2]) });
    }
    const snippets = [];
    while ((m = snipRe.exec(html)) !== null) {
      snippets.push(stripHtml(m[1]));
    }

    const results = [];
    const n = Math.min(links.length, limit);
    for (let i = 0; i < n; i++) {
      results.push({
        title: links[i].title || '(无标题)',
        url: links[i].url,
        snippet: snippets[i] || '',
      });
    }
    return results;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = (db) => {
  const router = Router();

  router.get('/websearch', async (req, res) => {
    const q = (req.query.q || '').toString().trim();
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 5, 1), 10);
    if (!q) {
      return res.json({ query: '', results: [], degraded: false, error: 'empty query' });
    }
    try {
      const results = await duckduckgoSearch(q, limit);
      return res.json({ query: q, results, degraded: results.length === 0 });
    } catch (e) {
      // 优雅降级：网络失败不阻断脚本，返回空结果供前端提示
      console.warn('[websearch] 抓取失败:', e && e.message ? e.message : e);
      return res.json({ query: q, results: [], degraded: true, error: e && e.message ? e.message : 'search failed' });
    }
  });

  return router;
};
