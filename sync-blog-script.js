#!/usr/bin/env node
/**
 * Obsidian知识库 → Hexo博客 同步脚本
 *
 * 功能：
 * 1. 遍历Obsidian知识库，按配置筛选需发布的文章
 * 2. 转换 [[Wiki链接]] 为标准Markdown链接
 * 3. 转换 Obsidian Callout (> [!type]) 为HTML
 * 4. 处理 dataview 代码块、%%注释%%
 * 5. 拷贝图片附件并修正路径
 * 6. 输出到 Hexo source/_posts 目录
 *
 * 用法：
 *   node sync-blog-script.js
 *
 * 环境变量：
 *   VAULT_PATH     - Obsidian知识库根目录（默认：脚本所在目录）
 *   HEXO_PATH      - Hexo博客根目录（默认：../hexo-blog）
 *   CONFIG_PATH    - 发布配置文件路径（默认：./blog-publish.config.json）
 */

const fs = require('fs');
const path = require('path');

// ============== 配置 ==============
const VAULT_PATH = process.env.VAULT_PATH || __dirname;
const HEXO_PATH = process.env.HEXO_PATH || path.join(__dirname, '..', 'hexo-blog');
const CONFIG_PATH = process.env.CONFIG_PATH || path.join(VAULT_PATH, 'blog-publish.config.json');
const POSTS_OUTPUT = path.join(HEXO_PATH, 'source', '_posts');
const IMAGES_OUTPUT = path.join(HEXO_PATH, 'source', 'images');

// 默认配置
const DEFAULT_CONFIG = {
  publishMode: 'all',           // all | published-only | whitelist
  whitelistDirs: [],            // whitelist模式下的目录白名单
  includeDrafts: false,         // 是否包含 _drafts 目录
  convertWikiLinks: true,       // 转换Wiki链接
  convertCallouts: true,        // 转换Callout
  handleDataview: true,         // 处理dataview代码块
  stripObsidianComments: true,  // 移除 %%注释%%
  copyImages: true,             // 拷贝图片
  slugFromFilename: true,       // 用文件名作为slug（保持Wiki链接可解析）
  dateFromFrontmatter: true,    // 优先用frontmatter中的date
  defaultDate: '2025-01-01',    // 默认日期
  skipDirs: ['.obsidian', '.git', '.trash', 'node_modules'],
  imageExtensions: ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp'],
};

// ============== 工具函数 ==============
function loadConfig() {
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      const userConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
      return { ...DEFAULT_CONFIG, ...userConfig };
    } catch (e) {
      console.warn('[WARN] 配置文件解析失败，使用默认配置:', e.message);
    }
  }
  return { ...DEFAULT_CONFIG };
}

function parseFrontmatter(content) {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!match) return { data: {}, content, raw: '' };
  const raw = match[1];
  const data = {};
  let currentKey = null;
  let inList = false;

  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    // 列表项
    if (inList && /^\s*-\s+/.test(line)) {
      const val = line.replace(/^\s*-\s+/, '').trim().replace(/^["']|["']$/g, '');
      if (Array.isArray(data[currentKey])) {
        data[currentKey].push(val);
      } else {
        data[currentKey] = [val];
      }
      continue;
    }
    inList = false;
    // key: value 或 key: [a, b]
    const kv = line.match(/^([\w-]+)\s*:\s*(.*)$/);
    if (kv) {
      const key = kv[1];
      let val = kv[2].trim();
      if (val === '') {
        data[key] = [];
        currentKey = key;
        inList = true;
      } else if (val.startsWith('[') && val.endsWith(']')) {
        // 内联数组
        data[key] = val.slice(1, -1).split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
      } else {
        data[key] = val.replace(/^["']|["']$/g, '');
        currentKey = key;
      }
    }
  }
  return { data, content: content.slice(match[0].length), raw };
}

function stringifyFrontmatter(data) {
  let lines = ['---'];
  for (const [key, val] of Object.entries(data)) {
    if (val === undefined || val === null || val === '') continue;
    if (Array.isArray(val)) {
      if (val.length === 0) continue;
      lines.push(`${key}:`);
      for (const item of val) {
        lines.push(`  - ${item}`);
      }
    } else {
      lines.push(`${key}: ${typeof val === 'string' && (val.includes(':') || val.includes('#')) ? `"${val}"` : val}`);
    }
  }
  lines.push('---');
  return lines.join('\n') + '\n\n';
}

function walkDir(dir, callback, skipDirs) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!skipDirs.includes(entry.name)) {
        walkDir(fullPath, callback, skipDirs);
      }
    } else if (entry.isFile()) {
      callback(fullPath);
    }
  }
}

// 从文件路径提取分类（基于目录结构）
function extractCategory(filePath, vaultPath) {
  const rel = path.relative(vaultPath, filePath);
  const parts = rel.split(path.sep);
  if (parts.length > 1) {
    // 去掉数字前缀，如 "01-编程基础" → "编程基础"
    return parts[0].replace(/^\d+-/, '');
  }
  return '未分类';
}

// ============== 文件名→slug 映射（用于Wiki链接解析） ==============
function buildFilenameMap(vaultPath, config) {
  const map = new Map();
  walkDir(vaultPath, (filePath) => {
    if (!filePath.endsWith('.md')) return;
    const basename = path.basename(filePath, '.md');
    const rel = path.relative(vaultPath, filePath);
    // 同时存 文件名 和 相对路径（不带扩展名），支持两种Wiki链接写法
    map.set(basename, basename);
    map.set(rel.replace(/\.md$/, '').replace(/\\/g, '/'), basename);
  }, config.skipDirs);
  return map;
}

// ============== Wiki链接转换 ==============
function convertWikiLinks(content, filenameMap) {
  // 匹配 [[链接]] 或 [[链接|别名]] 或 [[链接#锚点]] 或 [[链接#锚点|别名]]
  // 同时处理 ![[图片]] 嵌入语法
  return content.replace(/(!?)\[\[([^\]|#]+?)(?:#([^\]|]+))?(?:\|([^\]]+))?\]\]/g, (match, isEmbed, target, anchor, alias) => {
    target = target.trim();
    // 检查是否是图片嵌入
    const isImage = /\.(png|jpg|jpeg|gif|svg|webp|bmp)$/i.test(target);
    if (isEmbed && isImage) {
      const imgName = path.basename(target);
      const display = alias || imgName;
      return `![${display}](/images/${imgName})`;
    }
    // 普通笔记链接
    const slug = filenameMap.get(target) || target;
    const display = alias || target;
    const anchorPart = anchor ? `#${anchor}` : '';
    return `[${display}](/posts/${slug}/${anchorPart})`;
  });
}

// ============== Callout转换 ==============
const CALLOUT_STYLES = {
  note:     { icon: '📝', title: '笔记',     color: '#8b5cf6', bg: '#f5f3ff' },
  abstract: { icon: '📋', title: '摘要',     color: '#0ea5e9', bg: '#f0f9ff' },
  info:     { icon: 'ℹ️', title: '信息',     color: '#0284c7', bg: '#f0f9ff' },
  todo:     { icon: '✅', title: '待办',     color: '#16a34a', bg: '#f0fdf4' },
  tip:      { icon: '💡', title: '提示',     color: '#65a30d', bg: '#f7fee7' },
  success:  { icon: '✅', title: '成功',     color: '#16a34a', bg: '#f0fdf4' },
  question: { icon: '❓', title: '问题',     color: '#d97706', bg: '#fffbeb' },
  warning:  { icon: '⚠️', title: '警告',     color: '#d97706', bg: '#fffbeb' },
  failure:  { icon: '❌', title: '失败',     color: '#dc2626', bg: '#fef2f2' },
  danger:   { icon: '🚨', title: '危险',     color: '#dc2626', bg: '#fef2f2' },
  bug:      { icon: '🐛', title: 'Bug',     color: '#dc2626', bg: '#fef2f2' },
  example:  { icon: '💡', title: '示例',     color: '#7c3aed', bg: '#faf5ff' },
  quote:    { icon: '💬', title: '引用',     color: '#6b7280', bg: '#f9fafb' },
  important:{ icon: '❗', title: '重要',     color: '#dc2626', bg: '#fef2f2' },
  hint:     { icon: '💡', title: '提示',     color: '#65a30d', bg: '#f7fee7' },
};

function convertCallouts(content) {
  const lines = content.split('\n');
  const result = [];
  let inCallout = false;
  let calloutType = 'note';
  let calloutTitle = '';
  let calloutLines = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const calloutMatch = line.match(/^>\s*\[!(\w+)\](?:\s+(.*))?$/);

    if (calloutMatch) {
      // 结束上一个callout
      if (inCallout) {
        result.push(renderCallout(calloutType, calloutTitle, calloutLines));
        calloutLines = [];
      }
      inCallout = true;
      calloutType = calloutMatch[1].toLowerCase();
      calloutTitle = calloutMatch[2] || '';
      continue;
    }

    if (inCallout) {
      if (line.startsWith('> ')) {
        calloutLines.push(line.slice(2));
      } else if (line.trim() === '>') {
        calloutLines.push('');
      } else {
        // callout结束
        result.push(renderCallout(calloutType, calloutTitle, calloutLines));
        inCallout = false;
        calloutLines = [];
        result.push(line);
      }
    } else {
      result.push(line);
    }
  }
  if (inCallout) {
    result.push(renderCallout(calloutType, calloutTitle, calloutLines));
  }
  return result.join('\n');
}

function renderCallout(type, title, bodyLines) {
  const style = CALLOUT_STYLES[type] || CALLOUT_STYLES.note;
  const displayTitle = title || style.title;
  const body = bodyLines.join('\n').trim();
  return `<div style="border-left: 4px solid ${style.color}; background: ${style.bg}; padding: 12px 16px; margin: 16px 0; border-radius: 0 6px 6px 0;">
<p style="margin: 0 0 8px 0; font-weight: 600; color: ${style.color};">${style.icon} ${displayTitle}</p>
<div>

${body}

</div>
</div>`;
}

// ============== Dataview处理 ==============
function handleDataview(content) {
  return content.replace(/```dataview\n([\s\S]*?)```/g, (match, query) => {
    return `> [!info] 动态查询（Obsidian Dataview）
> 此内容为Obsidian Dataview动态查询，在博客中展示为静态提示。
> 查询语句：
> \`\`\`
${query.trim()}
\`\`\``;
  });
}

// ============== Obsidian注释移除 ==============
function stripObsidianComments(content) {
  // 移除 %%注释%%（支持多行）
  return content.replace(/%%[\s\S]*?%%/g, '');
}

// ============== 图片收集与拷贝 ==============
function collectAndCopyImages(content, vaultPath, config) {
  const imageRefs = new Set();
  // 匹配 ![[图片.png]] 和 ![alt](路径/图片.png)
  const wikiImgRegex = /!\[\[([^\]]+\.(?:png|jpg|jpeg|gif|svg|webp|bmp))\]\]/gi;
  const mdImgRegex = /!\[[^\]]*\]\(([^)]+\.(?:png|jpg|jpeg|gif|svg|webp|bmp))\)/gi;

  let match;
  while ((match = wikiImgRegex.exec(content)) !== null) {
    imageRefs.add(match[1]);
  }
  while ((match = mdImgRegex.exec(content)) !== null) {
    imageRefs.add(match[1]);
  }

  // 查找并拷贝图片
  for (const imgRef of imageRefs) {
    const imgName = path.basename(imgRef);
    // 在vault中搜索图片
    let foundPath = null;
    walkDir(vaultPath, (filePath) => {
      if (path.basename(filePath) === imgName) {
        foundPath = filePath;
      }
    }, config.skipDirs);

    if (foundPath) {
      const destPath = path.join(IMAGES_OUTPUT, imgName);
      if (!fs.existsSync(IMAGES_OUTPUT)) fs.mkdirSync(IMAGES_OUTPUT, { recursive: true });
      fs.copyFileSync(foundPath, destPath);
    }
  }
}

// ============== 主流程 ==============
function main() {
  const config = loadConfig();
  console.log('========== Obsidian → Hexo 同步开始 ==========');
  console.log(`知识库路径: ${VAULT_PATH}`);
  console.log(`Hexo路径:   ${HEXO_PATH}`);
  console.log(`发布模式:   ${config.publishMode}`);

  // 检查路径
  if (!fs.existsSync(VAULT_PATH)) {
    console.error(`[ERROR] 知识库路径不存在: ${VAULT_PATH}`);
    process.exit(1);
  }
  if (!fs.existsSync(HEXO_PATH)) {
    console.error(`[ERROR] Hexo路径不存在: ${HEXO_PATH}`);
    process.exit(1);
  }

  // 清空_posts目录（全量同步）
  if (fs.existsSync(POSTS_OUTPUT)) {
    fs.rmSync(POSTS_OUTPUT, { recursive: true });
  }
  fs.mkdirSync(POSTS_OUTPUT, { recursive: true });

  // 构建文件名映射
  const filenameMap = buildFilenameMap(VAULT_PATH, config);
  console.log(`已索引 ${filenameMap.size} 个笔记文件名（用于Wiki链接解析）`);

  // 收集所有md文件
  const allFiles = [];
  walkDir(VAULT_PATH, (filePath) => {
    if (!filePath.endsWith('.md')) return;
    allFiles.push(filePath);
  }, config.skipDirs);

  console.log(`知识库共找到 ${allFiles.length} 篇笔记`);

  let publishedCount = 0;
  let skippedCount = 0;

  for (const filePath of allFiles) {
    const relPath = path.relative(VAULT_PATH, filePath);
    const basename = path.basename(filePath, '.md');

    // 跳过草稿
    if (!config.includeDrafts && relPath.startsWith('_drafts')) {
      skippedCount++;
      continue;
    }

    // 读取并解析
    const rawContent = fs.readFileSync(filePath, 'utf-8');
    const { data: fm, content: body } = parseFrontmatter(rawContent);

    // 发布筛选
    let shouldPublish = false;
    if (config.publishMode === 'all') {
      shouldPublish = true;
    } else if (config.publishMode === 'published-only') {
      shouldPublish = fm.published === true || fm.published === 'true';
    } else if (config.publishMode === 'whitelist') {
      shouldPublish = config.whitelistDirs.some(dir => relPath.startsWith(dir));
    }

    if (!shouldPublish) {
      skippedCount++;
      continue;
    }

    // 转换处理
    let processedContent = body;
    if (config.stripObsidianComments) {
      processedContent = stripObsidianComments(processedContent);
    }
    if (config.handleDataview) {
      processedContent = handleDataview(processedContent);
    }
    if (config.convertCallouts) {
      processedContent = convertCallouts(processedContent);
    }
    if (config.convertWikiLinks) {
      processedContent = convertWikiLinks(processedContent, filenameMap);
    }

    // 拷贝图片
    if (config.copyImages) {
      collectAndCopyImages(processedContent, VAULT_PATH, config);
    }

    // 构建新的frontmatter
    const category = extractCategory(filePath, VAULT_PATH);
    const newFm = {
      title: fm.title || basename,
      date: fm.date || config.defaultDate,
      categories: [category],
      tags: Array.isArray(fm.tags) ? fm.tags : (fm.tags ? [fm.tags] : []),
    };

    // 保留有用的元数据
    if (fm.difficulty) newFm.difficulty = fm.difficulty;
    if (fm.est_minutes) newFm.est_minutes = fm.est_minutes;
    if (fm.chapter) newFm.chapter = fm.chapter;

    // 写入文件
    const outputPath = path.join(POSTS_OUTPUT, `${basename}.md`);
    const outputContent = stringifyFrontmatter(newFm) + processedContent;
    fs.writeFileSync(outputPath, outputContent, 'utf-8');
    publishedCount++;
  }

  console.log('');
  console.log('========== 同步完成 ==========');
  console.log(`发布文章: ${publishedCount} 篇`);
  console.log(`跳过文章: ${skippedCount} 篇`);
  console.log(`输出目录: ${POSTS_OUTPUT}`);
  console.log(`图片目录: ${IMAGES_OUTPUT}`);
}

main();
