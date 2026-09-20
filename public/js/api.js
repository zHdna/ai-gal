/**
 * AI Role-Play Tool - API Layer
 * 所有后端 API 调用的封装层
 * Base URL: http://127.0.0.1:3210/api
 */

const API_BASE = '/api';

// ============ 通用请求方法 ============

/**
 * 封装 fetch 请求
 * @param {string} path - API 路径（不含 /api 前缀）
 * @param {object} options - fetch 选项
 * @returns {Promise<object>} 解析后的 JSON 数据
 */
async function request(path, options = {}) {
  const url = `${API_BASE}${path}`;
  const config = {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  };

  // 如果有 body 且不是 FormData，自动序列化
  if (config.body && typeof config.body === 'object' && !(config.body instanceof FormData)) {
    config.body = JSON.stringify(config.body);
  }

  try {
    const res = await fetch(url, config);

    // 非 2xx 状态码处理
    if (!res.ok) {
      let errorData;
      try {
        errorData = await res.json();
      } catch {
        errorData = { error: `HTTP ${res.status}: ${res.statusText}` };
      }
      throw new ApiError(res.status, errorData.error || 'Unknown error', errorData);
    }

    // 204 No Content
    if (res.status === 204) return null;

    return await res.json();
  } catch (err) {
    // 网络错误
    if (err instanceof TypeError && err.message.includes('fetch')) {
      throw new ApiError(0, '无法连接到服务器，请确认服务已启动', {});
    }
    // 已经是 ApiError 则直接抛出
    if (err instanceof ApiError) throw err;
    // 其他未知错误
    throw new ApiError(500, err.message || '未知错误', {});
  }
}

/**
 * 自定义 API 错误类
 */
class ApiError extends Error {
  constructor(status, message, data) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
  }
}

// ============ Health Check ============

const HealthAPI = {
  /** 检查服务是否在线 */
  check() {
    return request('/health');
  },
};

// ============ API Providers ============

const ProviderAPI = {
  /** 获取所有供应商列表 */
  list() {
    return request('/providers');
  },

  /** 获取单个供应商详情 */
  get(id) {
    return request(`/providers/${id}`);
  },

  /** 创建供应商 */
  create(data) {
    return request('/providers', {
      method: 'POST',
      body: data,
    });
  },

  /** 更新供应商 */
  update(id, data) {
    return request(`/providers/${id}`, {
      method: 'PUT',
      body: data,
    });
  },

  /** 删除供应商 */
  delete(id) {
    return request(`/providers/${id}`, {
      method: 'DELETE',
    });
  },

  /** 获取模型列表 */
  fetchModels(baseUrl, apiKey, providerType) {
    return request('/providers/fetch-models', {
      method: 'POST',
      body: { base_url: baseUrl, api_key: apiKey, provider_type: providerType },
    });
  },
};

// ============ User Profile ============

const UserAPI = {
  /** 获取所有用户 */
  list() { return request('/user'); },
  /** 获取当前激活用户 */
  getActive() { return request('/user/active'); },
  /** 获取用户 */
  get(id) { return request(`/user/${id}`); },
  /** 创建用户 */
  create(data) { return request('/user', { method: 'POST', body: data }); },
  /** 更新用户 */
  update(id, data) { return request(`/user/${id}`, { method: 'PUT', body: data }); },
  /** 删除用户 */
  delete(id) { return request(`/user/${id}`, { method: 'DELETE' }); },
  /** 激活用户 */
  activate(id) { return request(`/user/${id}/activate`, { method: 'POST' }); },
  /** 上传头像 */
  uploadAvatar(id, file) {
    const fd = new FormData();
    fd.append('avatar', file);
    return fetch(`${API_BASE}/user/${id}/avatar`, { method: 'POST', body: fd }).then(r => r.json());
  },
  /** 上传游戏内身份（扮演角色）头像 */
  uploadPersonaAvatar(id, file) {
    const fd = new FormData();
    fd.append('avatar', file);
    return fetch(`${API_BASE}/user/${id}/persona-avatar`, { method: 'POST', body: fd }).then(r => r.json());
  },
};

// ============ Saves ============

const SavesAPI = {
  list() { return request('/saves'); },
  get(id) { return request(`/saves/${id}`); },
  create(data) { return request('/saves', { method: 'POST', body: data }); },
  export(id) { return request(`/saves/${id}/export`); },
  delete(id) { return request(`/saves/${id}`, { method: 'DELETE' }); },
  exportMD(id) {
    return fetch(`${API_BASE}/saves/${id}/export-md`)
      .then(r => {
        if (!r.ok) throw new Error('Export failed');
        return r.blob();
      });
  },
};

// ============ Card Fixer ============

const CardFixerAPI = {
  fix(data) {
    return request('/card-fixer/fix', {
      method: 'POST',
      body: data,
    });
  },
};

// ============ API Presets ============

const PresetAPI = {
  list(type) {
    return request('/presets' + (type ? `?type=${type}` : ''));
  },
  get(id) {
    return request('/presets/' + id);
  },
  save(id, data) {
    return request('/presets/' + id, { method: 'PUT', body: data });
  },
  delete(id) {
    return request('/presets/' + id, { method: 'DELETE' });
  },
  setDefault(id) {
    return request('/presets/' + id + '/set-default', { method: 'POST' });
  },
  /**
   * 导出为**标准 SillyTavern 聊天补全预设**的下载地址。
   * 服务端已附带 Content-Disposition，直接挂到 <a download> 上即可。
   */
  exportStUrl(id, opts = {}) {
    const q = new URLSearchParams();
    if (opts.provider) q.set('provider', opts.provider);
    const qs = q.toString();
    return `${API_BASE}/presets/${encodeURIComponent(id)}/export${qs ? '?' + qs : ''}`;
  },
  /** 导出映射报告：生成了哪些 ST 字段、丢弃了哪些、用的哪个供应商。 */
  exportStMeta(id, opts = {}) {
    const q = new URLSearchParams({ meta: '1' });
    if (opts.provider) q.set('provider', opts.provider);
    return request(`/presets/${encodeURIComponent(id)}/export?${q.toString()}`);
  },
};

// ============ Characters ============

const CharacterAPI = {
  /** 获取角色列表（摘要信息） */
  list() {
    return request('/characters');
  },

  /** 获取角色完整详情 */
  get(id) {
    return request(`/characters/${id}`);
  },

  /** 手动创建角色 */
  create(data) {
    return request('/characters', {
      method: 'POST',
      body: data,
    });
  },

  /** 导入 SillyTavern 角色卡 */
  import(data) {
    return request('/characters/import', {
      method: 'POST',
      body: data,
    });
  },

  /** 导入 PNG 角色卡（FormData 方式，避免 base64 存入 DB）*/
  async importFile(formData) {
    const res = await fetch(API_BASE + '/characters/import/file', {
      method: 'POST',
      body: formData,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || 'Import failed');
    }
    return res.json();
  },

  /** 更新角色 */
  update(id, data) {
    return request(`/characters/${id}`, {
      method: 'PUT',
      body: data,
    });
  },

  /** 删除角色 */
  delete(id) {
    return request(`/characters/${id}`, {
      method: 'DELETE',
    });
  },

  /** Get world book entries for a character */
  getBook(id) {
    return request(`/characters/${id}/book`);
  },

  /** Update world book entries (full replacement) */
  updateBook(id, data) {
    return request(`/characters/${id}/book`, {
      method: 'PUT',
      body: data,
    });
  },

  /** Add a new world book entry */
  addBookEntry(id, entry) {
    return request(`/characters/${id}/book/entry`, {
      method: 'POST',
      body: entry,
    });
  },

  /** Update a single world book entry */
  updateBookEntry(id, entryId, data) {
    return request(`/characters/${id}/book/entry/${entryId}`, {
      method: 'PUT',
      body: data,
    });
  },

  /** Delete a world book entry */
  deleteBookEntry(id, entryId) {
    return request(`/characters/${id}/book/entry/${entryId}`, {
      method: 'DELETE',
    });
  },

  /** Toggle entry enabled/disabled */
  toggleBookEntry(id, entryId) {
    return request(`/characters/${id}/book/entry/${entryId}/toggle`, {
      method: 'PATCH',
    });
  },
};

// ============ Conversations ============

const ConversationAPI = {
  /** 获取所有对话列表 */
  list() {
    return request('/conversations');
  },

  /** 获取单个对话详情 */
  get(id) {
    return request(`/conversations/${id}`);
  },

  /** 创建新对话 */
  create(data) {
    return request('/conversations', {
      method: 'POST',
      body: data,
    });
  },

  /** 更新对话（标题、系统提示、记忆上下文） */
  update(id, data) {
    return request(`/conversations/${id}`, {
      method: 'PUT',
      body: data,
    });
  },

  /** 删除对话 */
  delete(id) {
    return request(`/conversations/${id}`, {
      method: 'DELETE',
    });
  },

  /** 忽略 before 轮之前的对话（只保留记忆表格）；不删消息，可撤销 */
  memoryTrim(id, before) {
    return request(`/conversations/${id}/memory-trim`, {
      method: 'POST',
      body: { before },
    });
  },

  /** 撤销「忽略对话」，恢复完整历史 */
  memoryTrimUndo(id) {
    return request(`/conversations/${id}/memory-trim`, { method: 'DELETE' });
  },

  /** 查询当前忽略状态 */
  memoryTrimState(id) {
    return request(`/conversations/${id}/memory-trim`);
  },

  /** 清空对话消息（保留对话本身） */
  clearMessages(id) {
    return request(`/conversations/${id}/messages`, {
      method: 'DELETE',
    });
  },

  /**
   * 导出对话
   * @param {string} id - 对话 ID
   * @param {'summary'|'full'} mode - summary=主窗口内容, full=完整内容
   */
  async export(id, mode) {
    const url = `${API_BASE}/conversations/${id}/export?mode=${mode}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Export failed: ${res.status}`);
    const blob = await res.blob();
    const ext = mode === 'summary' ? 'txt' : 'json';
    const downloadUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = downloadUrl;
    a.download = `conversation-${id}-${mode}.${ext}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(downloadUrl);
  },
};

// ============ Messages ============

const MessageAPI = {
  /** 获取指定对话的所有消息（★ limit 显式给大值：后端分页默认曾截断为最早 100 条，
      导致 >100 条对话的最新消息加载不全 —— 数据在库但前端显示缺最新几条） */
  list(conversationId) {
    return request(`/messages/conversation/${conversationId}?limit=10000`);
  },

  /**
   * 加载最新 N 条消息（长聊天折叠：初始只取最新 100 条，节约资源）
   * @returns {Promise<{messages: Array, total: number}>}
   */
  async loadLatest(conversationId, limit = 100) {
    const res = await fetch(`${API_BASE}/messages/conversation/${conversationId}?limit=${limit}&latest=1`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const messages = await res.json();
    return { messages, total: parseInt(res.headers.get('X-Total-Count') || '0', 10) };
  },

  /**
   * 加载指定消息之前的更早消息（游标向前翻页）
   * @param {string} conversationId
   * @param {string} beforeId 当前已加载最早一条消息的 id
   * @returns {Promise<{messages: Array, total: number}>}
   */
  async loadEarlier(conversationId, beforeId, limit = 100) {
    const res = await fetch(`${API_BASE}/messages/conversation/${conversationId}?limit=${limit}&before_id=${encodeURIComponent(beforeId)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const messages = await res.json();
    return { messages, total: parseInt(res.headers.get('X-Total-Count') || '0', 10) };
  },

  /** 获取单条消息 */
  get(id) {
    return request(`/messages/${id}`);
  },

  /** 创建消息 */
  create(data) {
    return request('/messages', {
      method: 'POST',
      body: data,
    });
  },

  /** 删除消息 */
  delete(id) {
    return request(`/messages/${id}`, {
      method: 'DELETE',
    });
  },

  /**
   * 批量设置消息的 hidden 状态
   * @param {string[]} message_ids - 消息 ID 列表
   * @param {boolean} hidden - true=从AI上下文中隐藏, false=恢复
   */
  batchHide(message_ids, hidden) {
    return request('/messages/batch-hide', {
      method: 'PATCH',
      body: { message_ids, hidden },
    });
  },

  /**
   * 批量删除消息
   * @param {string[]} message_ids - 消息 ID 列表
   */
  batchDelete(message_ids) {
    return request('/messages/batch-delete', {
      method: 'POST',
      body: { message_ids },
    });
  },
};

// ============ Chat (AI Completion) ============

const ChatAPI = {
  /**
   * 发送消息并获取 AI 回复（非流式）
   * @param {string} conversationId - 对话 ID
   * @param {string} content - 用户消息内容
   * @param {string} [providerId] - 指定供应商 ID（可选，默认用默认供应商）
   * @returns {Promise<object>} AI 回复 { id, role, content, formatted, model }
   */
  complete(conversationId, content, providerId) {
    const body = { conversation_id: conversationId, content };
    if (providerId) body.provider_id = providerId;
    return request('/chat/completions', {
      method: 'POST',
      body,
    });
  },

  /**
   * 发送消息并流式获取 AI 回复（SSE）
   * @param {string} conversationId - 对话 ID
   * @param {string} content - 用户消息内容
   * @param {string} [providerId] - 指定供应商 ID（可选）
   * @param {object} callbacks - 回调函数集合
   * @param {function} callbacks.onToken - 收到 token 时调用 (token: string) => void
   * @param {function} callbacks.onDone - 流式完成时调用 (result: object) => void
   * @param {function} callbacks.onError - 出错时调用 (error: string) => void
   * @param {function} callbacks.onUserMessage - 用户消息已存储 (msg: object) => void
   * @returns {Promise<void>}
   */
  async stream(conversationId, content, providerId, callbacks = {}) {
    const body = { conversation_id: conversationId, content };
    if (providerId) body.provider_id = providerId;

    const url = `${API_BASE}/chat/stream`;

    let reader = null;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new ApiError(res.status, err.error || 'Stream request failed', err);
      }

      reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let currentEventType = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) {
            // Empty line = end of SSE event
            currentEventType = '';
            continue;
          }

          if (trimmed.startsWith('event: ')) {
            currentEventType = trimmed.slice(7).trim();
            continue;
          }

          if (trimmed.startsWith('data: ')) {
            const dataStr = trimmed.slice(6);
            try {
              const data = JSON.parse(dataStr);

              switch (currentEventType) {
                case 'user_message':
                  callbacks.onUserMessage?.(data);
                  break;
                case 'token':
                  if (data.token !== undefined) {
                    callbacks.onToken?.(data.token);
                  }
                  break;
                case 'reasoning':
                  if (data.token !== undefined) {
                    callbacks.onReasoning?.(data.token);
                  }
                  break;
                case 'done':
                  callbacks.onDone?.(data);
                  break;
                case 'error':
                  // 服务端两种字段都出现过：{message} 与 {error}
                  callbacks.onError?.(data.error || data.message || 'Unknown stream error');
                  break;
                case 'aborted':
                  callbacks.onError?.('Generation aborted');
                  break;
                case 'memory-drop-prompt':
                  // 第 M 轮：服务端询问是否忽略之前的对话、只保留记忆表格
                  callbacks.onMemoryDropPrompt?.(data);
                  break;
                default:
                  // Try to auto-detect by data shape
                  if (data.token !== undefined) {
                    callbacks.onToken?.(data.token);
                  } else if (data.id && data.role === 'assistant') {
                    callbacks.onDone?.(data);
                  } else if (data.error) {
                    callbacks.onError?.(data.error);
                  }
              }
            } catch (e) {
              // Non-JSON data, ignore
            }
          }
        }
      }
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw new ApiError(500, err.message || 'Stream failed', {});
    } finally {
      // 确保 reader 被取消，避免未消费的流体导致 Chromium 浏览器内存泄漏
      if (reader) {
        try { reader.cancel(); } catch { /* ignore */ }
      }
    }
  },

  /** 中止当前生成 */
  abort() {
    return request('/chat/abort', {
      method: 'POST',
    });
  },
};

// ============ Themes ============

const ThemeAPI = {
  /** 获取当前主题设置 */
  get() {
    return request('/themes');
  },

  /** 更新主题 */
  update(data) {
    return request('/themes', {
      method: 'PUT',
      body: data,
    });
  },

  /** 重置为默认 Amber 主题 */
  reset() {
    return request('/themes/reset', {
      method: 'POST',
    });
  },

  /** 获取应用设置 (system prompt) */
  getSettings() {
    return request('/themes/settings');
  },

  /** 保存应用设置 */
  saveSettings(data) {
    return request('/themes/settings', {
      method: 'PUT',
      body: data,
    });
  },
};

// ============ Memory Agent ============

const MemoryAgentAPI = {
  /** 获取记忆增强设置 */
  get() {
    return request('/memory-agent');
  },

  /** 更新记忆增强设置 */
  update(data) {
    return request('/memory-agent', {
      method: 'PUT',
      body: data,
    });
  },

  /** 手动触发记忆更新 */
  trigger(conversationId) {
    return request('/memory-agent/trigger', {
      method: 'POST',
      body: { conversation_id: conversationId },
    });
  },

  /** 获取事件日志 + 倒计时 */
  getEventLog(conversationId) {
    return request('/memory-agent/event-log?conversation_id=' + encodeURIComponent(conversationId));
  },

  /** 保存事件日志 */
  saveEventLog(conversationId, log) {
    return request('/memory-agent/event-log', {
      method: 'PUT',
      body: { conversation_id: conversationId, log },
    });
  },

  /** 每轮记忆状态（黄=已登记 / 绿=已注入 / 红=内容缺失） */
  getMemoryStatus(conversationId) {
    return request('/memory-agent/memory-status?conversation_id=' + encodeURIComponent(conversationId));
  },
};

// ============ Image Generation ============

const ImageAPI = {
  /** 获取图像生成设置 */
  get() {
    return request('/images');
  },

  /** 更新图像生成设置 */
  update(data) {
    return request('/images', {
      method: 'PUT',
      body: data,
    });
  },

  /** 生成图像 */
  generate(data) {
    return request('/images/generate', {
      method: 'POST',
      body: data,
    });
  },
};

// ============ STscript Variables (persistence) ============

const ScriptVarsAPI = {
  /**
   * 列出某作用域下全部变量
   * @param {'local'|'global'} scope
   * @param {string} ownerId - local: conversationId, global: userId
   */
  list(scope, ownerId) {
    const key = scope === 'global' ? 'user_id' : 'conversation_id';
    return request(`/script-vars?scope=${scope}&${key}=${encodeURIComponent(ownerId)}`);
  },

  /**
   * 写入/更新单个变量
   * @param {'local'|'global'} scope
   * @param {string} ownerId
   * @param {string} name
   * @param {string|number} value
   * @param {'string'|'number'|'json'} [type]
   */
  set(scope, ownerId, name, value, type) {
    const key = scope === 'global' ? 'user_id' : 'conversation_id';
    return request('/script-vars', {
      method: 'POST',
      body: { scope, [key]: ownerId, name, value, type },
    });
  },

  /**
   * 删除单个变量（传 name）或清空整个作用域（不传 name，对应 /flushvar）
   * @param {'local'|'global'} scope
   * @param {string} ownerId
   * @param {string} [name]
   */
  remove(scope, ownerId, name) {
    const key = scope === 'global' ? 'user_id' : 'conversation_id';
    const q = `scope=${scope}&${key}=${encodeURIComponent(ownerId)}${name ? `&name=${encodeURIComponent(name)}` : ''}`;
    return request(`/script-vars?${q}`, { method: 'DELETE' });
  },
};
