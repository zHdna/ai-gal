/**
 * AI Role-Play Tool - Main Application Logic
 * UI 交互、状态管理、事件监听
 * 布局：折叠侧栏 | 聊天区 | 信息面板（画廊+状态栏）
 */

// Default prompts (shown when no custom prompt is saved)
const DEFAULT_CARD_FIXER_PROMPT = `你是一个角色卡分析和优化助手。你的唯一任务是把输入的角色卡系统提示词进行结构优化。

【优化规则】

1. **去重合并**：把重复的、含义相近的段落合并为一段简洁的描述。保留所有关键信息，但去除冗余表述。

2. **HTML注释转换**：如果角色卡中含有 <!-- --> 包裹的信息（如角色属性数据），必须原样保留其内容，用 <p class="nowork"><!--原始内容--></p> 格式包裹。不要删除或修改注释内的数据。

3. **角色个性保留**：不要修改角色的性格、说话风格、世界观设定。只优化格式和组织结构。不要加入任何输出格式指令，格式规范已由主AI负责。

4. **状态变量提取**：从角色卡中识别所有需要追踪的动态状态和属性变量（如生命值、魔力值、金钱、经验、物品、好感度等），在优化后的系统提示词末尾以独立段落追加状态变量白名单：

<p class="nowork">
<!-- STATUS_VARS -->
{
  "可追踪状态": [
    {"变量名": "HP", "中文名": "生命值", "初始值": "100/100", "描述": "角色的生命值"},
    {"变量名": "MP", "中文名": "魔力值", "初始值": "50/50", "描述": "角色的魔力值"}
  ]
}
<!-- /STATUS_VARS -->
</p class="nowork">

变量名用英文标识符（可以作为代码中的key），中文名用于前端显示。初始值根据角色卡设定填写（如未设定则填"未设定"）。描述用简短中文说明该变量的含义。

5. **输出格式**：直接输出优化后的完整系统提示词文本，不要加任何解释、前言或后缀。`;

const DEFAULT_MEMORY_AGENT_PROMPT = `你是一个记忆记录助手。请你分析以下对话/叙述内容，将其浓缩为一句摘要。

摘要必须包含以下要素（如果缺失，标注"未提及"）：
- 时间：什么时间
- 地点：在哪里
- 人物：涉及哪些角色
- 事件：发生什么事
- 物品：涉及什么重要物品

只输出一句20-50字的摘要，不要任何解释。`;

// ============ 全局状态 ============
const AppState = {
  characters: [],           // 角色列表缓存
  conversations: [],       // 对话列表缓存
  currentCharacter: null,  // 当前选中角色 (完整对象)
  currentConversation: null, // 当前对话 (完整对象)
  messages: [],            // 当前对话的消息列表
  providers: [],           // API 供应商列表
  themeVars: {},           // 当前主题 CSS 变量
  isGenerating: false,     // AI 是否正在生成中
  editingCharacterId: null, // 正在编辑的角色 ID (null=新建)
  editingProviderId: null,  // 正在编辑的供应商 ID (null=新建)
  worldBookEntries: [],     // 当前编辑角色的世界书条目缓存
  sidebarExpanded: false,   // 侧边栏是否展开
  expandedCharId: null,     // 当前展开存档列表的角色卡 ID（手风琴模式，同时只展开一个）
  activeTab: 'chat',         // 当前选项卡: 'chat' | 'debug'
  activeDebugSubTab: 'mainAgent', // 调试面板子选项卡: 'mainAgent' | 'butler'
  // 画廊
  galleryImages: [],        // 当前对话的图片 URL 列表
  cgGallery: [],            // CG 图片列表 [{filename, character, prompt, timestamp}]
  galleryIndex: 0,          // 当前显示的图片索引
  // 状态栏
  userStatus: {},      // 角色状态变量 { key: value }
  // MVU 世界状态模型（Tier 3 闭环）：engine 卡的角色属性/世界状态树
  worldState: {},
  worldStateLoaded: false,
  // 楼层计数器（每对 user+assistant = 1 轮）
  roundCounter: 0,
  // 调试面板轮次计数器（与 roundCounter 同步）
  debugRoundCounter: 0,
  // 用户设定
  userProfile: { id: 0, name: '我', avatar: '', intro: '', persona_name: '', persona_avatar: '' },
  allUsers: [],
  editingUserId: null,
  // Token 统计 (from backend)
  tokenContext: 0,    // 当前上下文窗口token (system+history+current input)
  tokenTotal: 0,     // 对话累计总消耗token
  systemTokens: 0,   // 系统提示词token (preset+角色卡+内置提示词)
  // 角色颜色映射 { name: { dark: 'rgba(...)', light: 'rgba(...)', index: N } }
  characterColors: {},
  // 角色名册 { name: { avatar: 'path/to/img.jpg', ... } }
  characterRoster: {},
};

// 移动端外壳（public/mobile.html）需要读取当前角色 / 对话与角色列表；
// 这里把全局状态显式暴露到 window，桌面版行为不受影响。
window.AppState = AppState;

// ============ 角色颜色系统 ============

const CHAR_PALETTE = [
  { dark: 'rgba(60, 25, 30, 0.85)', light: 'rgba(255, 230, 235, 0.88)' },  // 浅红
  { dark: 'rgba(25, 55, 80, 0.85)', light: 'rgba(225, 245, 255, 0.88)' },  // 浅蓝
  { dark: 'rgba(45, 25, 65, 0.85)', light: 'rgba(240, 230, 255, 0.88)' },  // 浅紫
  { dark: 'rgba(20, 70, 55, 0.85)', light: 'rgba(225, 255, 240, 0.88)' },  // 浅青
  { dark: 'rgba(70, 40, 15, 0.85)', light: 'rgba(255, 240, 220, 0.88)' },  // 浅橙
  { dark: 'rgba(60, 35, 55, 0.85)', light: 'rgba(255, 235, 250, 0.88)' },  // 浅粉
  { dark: 'rgba(30, 60, 50, 0.85)', light: 'rgba(230, 250, 240, 0.88)' },  // 浅绿
  { dark: 'rgba(55, 50, 20, 0.85)', light: 'rgba(255, 248, 225, 0.88)' },  // 浅金
];
const USER_COLOR_DARK = 'rgba(65, 40, 15, 0.88)';   // 暗色主题：暖褐
const USER_COLOR_LIGHT = 'rgba(255, 248, 220, 0.92)'; // 亮色主题：浅黄

let _paletteIndex = 0;

function getCharColor(name) {
  if (!name) return null;
  // 用户固定色（支持多种可能的用户名）
  const userName = (AppState.userProfile && AppState.userProfile.name) || '我';
  if (name === userName || name === '你') {
    return { dark: USER_COLOR_DARK, light: USER_COLOR_LIGHT, isUser: true };
  }
  // 已分配 → 返回
  if (AppState.characterColors[name]) return AppState.characterColors[name];
  // 新分配
  const color = CHAR_PALETTE[_paletteIndex % CHAR_PALETTE.length];
  _paletteIndex++;
  AppState.characterColors[name] = { ...color, index: _paletteIndex - 1 };
  saveCharacterColors();
  return AppState.characterColors[name];
}

function getCurrentBubbleColor(name) {
  const color = getCharColor(name);
  if (!color) return null;
  const isLight = document.body.getAttribute('theme-mode') === 'light';
  return color[isLight ? 'light' : 'dark'];
}

async function saveCharacterColors() {
  if (!AppState.currentConversation) return;
  try {
    const saves = await SavesAPI.list().catch(() => []);
    const save = saves.find(s => s.conversation_id === AppState.currentConversation.id);
    if (save) {
      await request('/saves/' + save.id + '/colors', {
        method: 'PUT',
        body: { colors: AppState.characterColors, roster: AppState.characterRoster }
      });
    }
  } catch { /* ignore */ }
}

async function loadCharacterColors() {
  if (!AppState.currentConversation) return;
  try {
    const saves = await SavesAPI.list().catch(() => []);
    const save = saves.find(s => s.conversation_id === AppState.currentConversation.id);
    if (save) {
      const resp = await request('/saves/' + save.id + '/colors').catch(() => null);
      if (resp && resp.colors) {
        AppState.characterColors = resp.colors;
        _paletteIndex = Math.max(0, ...Object.values(resp.colors).map(c => (c.index || 0) + 1));
      }
      // Also load character roster
      const rosterResp = await request('/saves/' + save.id + '/roster').catch(() => null);
      if (rosterResp && rosterResp.roster) {
        AppState.characterRoster = rosterResp.roster;
        // Restore colors from roster
        Object.entries(rosterResp.roster).forEach(([name, data]) => {
          if (data._color) AppState.characterColors[name] = data._color;
        });
      }
    }
  } catch { /* ignore */ }
}

function getCurrentSaveId() {
  return AppState._currentSaveId || '';
}

// ============ DOM 元素缓存 ============

const DOM = {
  // 顶栏
  btnGameSettings: () => document.getElementById('btnGameSettings'),
  btnSettings: () => document.getElementById('btnSettings'),
  btnExport: () => document.getElementById('btnExport'),
  btnRestart: () => document.getElementById('btnRestart'),
  conversationTitle: () => document.getElementById('conversationTitle'),

  // 左侧栏
  leftSidebar: () => document.getElementById('leftSidebar'),
  sidebarStrip: () => document.getElementById('sidebarStrip'),
  sidebarPanel: () => document.getElementById('sidebarPanel'),
  btnExpandSidebar: () => document.getElementById('btnExpandSidebar'),
  btnCollapseSidebar: () => document.getElementById('btnCollapseSidebar'),
  stripAvatars: () => document.getElementById('stripAvatars'),
  btnNewCharacterStrip: () => document.getElementById('btnNewCharacterStrip'),
  characterList: () => document.getElementById('characterList'),
  btnNewCharacter: () => document.getElementById('btnNewCharacter'),
  btnImportCharacter: () => document.getElementById('btnImportCharacter'),
  btnImportCharacterEmpty: () => document.getElementById('btnImportCharacterEmpty'),

  // 聊天区
  chatArea: () => document.getElementById('chatArea'),
  welcomeScreen: () => document.getElementById('welcomeScreen'),
  chatContainer: () => document.getElementById('chatContainer'),
  messagesArea: () => document.getElementById('messagesArea'),
  messageInput: () => document.getElementById('messageInput'),
  btnSend: () => document.getElementById('btnSend'),
  // Token 计数器
  tokenCounter: () => document.getElementById('tokenCounter'),
  tokenContext: () => document.getElementById('tokenContext'),
  tokenTotal: () => document.getElementById('tokenTotal'),

  // 信息面板
  infoPanel: () => document.getElementById('infoPanel'),
  galleryViewport: () => document.getElementById('galleryViewport'),
  galleryEmpty: () => document.getElementById('galleryEmpty'),
  galleryImage: () => document.getElementById('galleryImage'),
  galleryCounter: () => document.getElementById('galleryCounter'),
  btnPrevImage: () => document.getElementById('btnPrevImage'),
  btnNextImage: () => document.getElementById('btnNextImage'),
  statusContent: () => document.getElementById('statusContent'),

  // 设置弹窗
  settingsModal: () => document.getElementById('settingsModal'),
  settingsModalOverlay: () => document.getElementById('settingsModalOverlay'),
  settingsModalClose: () => document.getElementById('settingsModalClose'),

  // 游戏设置弹窗
  gameSettingsModal: () => document.getElementById('gameSettingsModal'),
  gameSettingsOverlay: () => document.getElementById('gameSettingsOverlay'),
  gameSettingsClose: () => document.getElementById('gameSettingsClose'),
  userNameInp: () => document.getElementById('userName'),
  userAvatarPreview: () => document.getElementById('userAvatarPreview'),
  userAvatarFile: () => document.getElementById('userAvatarFile'),
  personaNameInp: () => document.getElementById('personaName'),
  personaAvatarPreview: () => document.getElementById('personaAvatarPreview'),
  personaAvatarFile: () => document.getElementById('personaAvatarFile'),
  btnUploadPersonaAvatar: () => document.getElementById('btnUploadPersonaAvatar'),
  userIntroInp: () => document.getElementById('userIntro'),
  userSwitcher: () => document.getElementById('userSwitcher'),
  btnSaveUser: () => document.getElementById('btnSaveUser'),
  btnNewUser: () => document.getElementById('btnNewUser'),
  btnDeleteUser: () => document.getElementById('btnDeleteUser'),
  btnUploadAvatar: () => document.getElementById('btnUploadAvatar'),
  providerList: () => document.getElementById('providerList'),
  btnAddProvider: () => document.getElementById('btnAddProvider'),
  themeSettings: () => document.getElementById('themeSettings'),
  btnResetTheme: () => document.getElementById('btnResetTheme'),
  btnSetDefaultTheme: () => document.getElementById('btnSetDefaultTheme'),
  btnExportTheme: () => document.getElementById('btnExportTheme'),
  btnImportTheme: () => document.getElementById('btnImportTheme'),
  themeFileInput: () => document.getElementById('themeFileInput'),
  memoryAgentSettings: () => document.getElementById('memoryAgentSettings'),
  imageSettings: () => document.getElementById('imageSettings'),

  // API Presets Modal
  apiPresetsModal: () => document.getElementById('apiPresetsModal'),
  apiPresetsOverlay: () => document.getElementById('apiPresetsOverlay'),
  apiPresetsClose: () => document.getElementById('apiPresetsClose'),
  btnOpenApiPresets: () => document.getElementById('btnOpenApiPresets'),
  chatPresetSelect: () => document.getElementById('chatPresetSelect'),
  btnImportSTPreset: () => document.getElementById('btnImportSTPreset'),
  btnExportSTPreset: () => document.getElementById('btnExportSTPreset'),
  btnDefaultChatPreset: () => document.getElementById('btnDefaultChatPreset'),
  btnDeleteChatPreset: () => document.getElementById('btnDeleteChatPreset'),
  stPresetFile: () => document.getElementById('stPresetFile'),
  presetParams: () => document.getElementById('presetParams'),
  imageGenSettings: () => document.getElementById('imageGenSettings'),

  // Multimedia bar
  btnToggleAudio: () => document.getElementById('btnToggleAudio'),
  audioIcon: () => document.getElementById('audioIcon'),
  btnImageGenSettings: () => document.getElementById('btnImageGenSettings'),

  // Slide panel for system prompt editing
  spEditorPanel: () => document.getElementById('spEditorPanel'),
  spEditorTitle: () => document.getElementById('spEditorTitle'),
  spEditorName: () => document.getElementById('spEditorName'),
  spEditorContent: () => document.getElementById('spEditorContent'),

  // 角色弹窗
  characterModal: () => document.getElementById('characterModal'),
  characterModalOverlay: () => document.getElementById('characterModalOverlay'),
  characterModalTitle: () => document.getElementById('characterModalTitle'),
  characterModalClose: () => document.getElementById('characterModalClose'),
  characterForm: () => document.getElementById('characterForm'),
  charName: () => document.getElementById('charName'),
  charAvatar: () => document.getElementById('charAvatar'),
  charPersonality: () => document.getElementById('charPersonality'),
  charScenario: () => document.getElementById('charScenario'),
  charDescription: () => document.getElementById('charDescription'),
  charSystemPrompt: () => document.getElementById('charSystemPrompt'),
  charPostHistory: () => document.getElementById('charPostHistory'),
  worldBookSection: () => document.getElementById('worldBookSection'),
  wbEntryCount: () => document.getElementById('wbEntryCount'),
  wbEntriesList: () => document.getElementById('wbEntriesList'),
  btnAddWBEntry: () => document.getElementById('btnAddWBEntry'),
  charFirstMessage: () => document.getElementById('charFirstMessage'),
  charTags: () => document.getElementById('charTags'),
  btnCancelCharacter: () => document.getElementById('btnCancelCharacter'),
  btnSaveCharacter: () => document.getElementById('btnSaveCharacter'),
  btnFixCharacter: () => document.getElementById('btnFixCharacter'),

  // 供应商弹窗
  providerModal: () => document.getElementById('providerModal'),
  providerModalOverlay: () => document.getElementById('providerModalOverlay'),
  providerModalTitle: () => document.getElementById('providerModalTitle'),
  providerModalClose: () => document.getElementById('providerModalClose'),
  providerForm: () => document.getElementById('providerForm'),
  providerName: () => document.getElementById('providerName'),
  providerType: () => document.getElementById('providerType'),
  providerUrl: () => document.getElementById('providerUrl'),
  providerApiKey: () => document.getElementById('providerApiKey'),
  providerModel: () => document.getElementById('providerModel'),
  providerModelSelect: () => document.getElementById('providerModelSelect'),
  providerThinking: () => document.getElementById('providerThinking'),
  btnFetchModels: () => document.getElementById('btnFetchModels'),
  providerHeaders: () => document.getElementById('providerHeaders'),
  providerIsDefault: () => document.getElementById('providerIsDefault'),
  btnCancelProvider: () => document.getElementById('btnCancelProvider'),
  btnSaveProvider: () => document.getElementById('btnSaveProvider'),

  // 文件输入
  characterFileInput: () => document.getElementById('characterFileInput'),

  // 手机弹出菜单（数据中心）
  btnPhoneFloat: () => document.getElementById('btnPhoneFloat'),
  phonePopup: () => document.getElementById('phonePopup'),
  phoneRosterPage: () => document.getElementById('phoneRosterPage'),
  phoneStatusPage: () => document.getElementById('phoneStatusPage'),
  phoneMemoryPage: () => document.getElementById('phoneMemoryPage'),
  phoneGalleryPage: () => document.getElementById('phoneGalleryPage'),
  phoneCharDetailPage: () => document.getElementById('phoneCharDetailPage'),
  phoneTime: () => document.getElementById('phoneTime'),
  phoneTime: () => document.getElementById('phoneTime'),
  statusPopupBody: () => document.getElementById('statusPopupBody'),
  rosterList: () => document.getElementById('rosterList'),
  memoryList: () => document.getElementById('memoryList'),
  phoneGalleryGrid: () => document.getElementById('phoneGalleryGrid'),
  charDetailContent: () => document.getElementById('charDetailContent'),
  // 编辑弹窗
  editModal: () => document.getElementById('editModal'),
  editModalOverlay: () => document.getElementById('editModalOverlay'),
  editModalClose: () => document.getElementById('editModalClose'),
  editTextarea: () => document.getElementById('editTextarea'),
  btnEditSave: () => document.getElementById('btnEditSave'),
  btnEditCancel: () => document.getElementById('btnEditCancel'),

  // 选项卡
  chatTabBar: () => document.getElementById('chatTabBar'),
  chatTabContent: () => document.getElementById('chatTabContent'),
  debugTabContent: () => document.getElementById('debugTabContent'),
  debugMainAgentContent: () => document.getElementById('debugMainAgentContent'),
  debugButlerContent: () => document.getElementById('debugButlerContent'),
};

// ============ Toast 通知系统 ============

function showToast(message, type = 'info', duration = 3000) {
  let container = document.querySelector('.toast-container');
  if (!container) {
    container = document.createElement('div');
    container.className = 'toast-container';
    document.body.appendChild(container);
  }

  // Cap visible toasts so a burst of errors can't flood / stack forever.
  const MAX_TOASTS = 5;
  while (container.children.length >= MAX_TOASTS) {
    if (container.firstElementChild) container.firstElementChild.remove();
  }

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  toast.style.cursor = 'pointer';
  toast.title = '点击关闭';
  container.appendChild(toast);

  requestAnimationFrame(() => toast.classList.add('show'));

  let removed = false;
  const dismiss = () => {
    if (removed) return;
    removed = true;
    toast.classList.remove('show');
    // Remove after the fade-out transition (or immediately if transitions are off).
    setTimeout(() => { if (toast.isConnected) toast.remove(); }, 400);
  };

  // GUARANTEED auto-dismiss via timer. Do NOT rely on transitionend alone —
  // when CSS transitions are disabled (reduced-motion / some setups) transitionend
  // never fires and the toast would stay on screen forever.
  const timer = setTimeout(dismiss, duration);

  // Bonus: dismiss as soon as the exit transition finishes (if it runs).
  toast.addEventListener('transitionend', () => {
    if (!toast.classList.contains('show')) dismiss();
  });

  // Click to dismiss immediately.
  toast.addEventListener('click', () => { clearTimeout(timer); dismiss(); });
}

// 轻量 toast 封装（与 stscript.js 内同名函数保持一致，供各处调用）
function showToastSafe(text, severity) {
  try { showToast(text, severity || 'info'); }
  catch (e) { console.log('[toast:' + (severity || 'info') + '] ' + text); }
}

// ============ 初始化 ============

document.addEventListener('DOMContentLoaded', async () => {
  initThemeMode();
  initThemePreset();
  initBGM();
  initTtsMasterSwitch();
  ttsLoadSettings();
  bindEvents();
  await loadInitialData();
  replayScriptUIState();
});

// ============ 桌面 ⇄ 移动 切换键 ============
// 2026-09-13：移动端前端已启用（public/mobile.html），此键用于手动切到移动端。
const MOBILE_FRONTEND_DISABLED = false;
function switchToMobile() {
  if (MOBILE_FRONTEND_DISABLED) {
    console.info('[mobile] 移动端前端当前已屏蔽，保持桌面版');
    return;
  }
  // 清除「强制桌面版」偏好，否则移动端页面会被再次跳回桌面
  try {
    localStorage.removeItem('forceDesktop');
    document.cookie = 'forceDesktop=; Path=/; Max-Age=0; SameSite=Lax';
  } catch (e) { }
  const id = AppState.currentConversation ? AppState.currentConversation.id : '';
  const url = 'mobile.html' + (id ? ('?conv=' + encodeURIComponent(id)) : '');
  try { if (id) localStorage.setItem('mobile-lastConv', id); } catch (e) { }
  location.replace(url);
}
// 桌面版「恢复移动端自动跳转」入口（设置页调用）
function restoreMobileFrontend() {
  try {
    localStorage.removeItem('forceDesktop');
    document.cookie = 'forceDesktop=; Path=/; Max-Age=0; SameSite=Lax';
  } catch (e) { }
  showToast('已恢复：手机/平板访问将自动进入移动端');
}
window.switchToMobile = switchToMobile;
window.restoreMobileFrontend = restoreMobileFrontend;

async function loadInitialData() {
  try {
    const [characters, providers, theme, userProfile] = await Promise.all([
      CharacterAPI.list().catch(() => []),
      ProviderAPI.list().catch(() => []),
      ThemeAPI.get().catch(() => null),
      UserAPI.getActive().catch(() => ({ name: '我', avatar: '', intro: '' })),
    ]);

    AppState.characters = characters;
    AppState.providers = providers;
    AppState.userProfile = userProfile;

    if (theme) {
      // Per-mode theme vars: { dark: {...overrides}, light: {...overrides} }
      AppState.themeVars = theme.css_variables || { dark: {}, light: {} };
      applyThemeVars();
    }

    renderStripAvatars();
    renderCharacterList();
    renderProviderList();
    renderThemeSettings();
    renderMemoryAgentSettings();
    renderImageSettings();
    } catch (err) {
      console.error('[Init] 加载初始数据失败:', err);
      showToast('加载数据失败，请刷新重试', 'error');
    }

    // 调试：从移动端切换过来（?conv=ID），直接进入指定对话
    try {
      const cp = new URLSearchParams(location.search).get('conv');
      if (cp) loadConversation(cp).catch(() => {});
    } catch (e) {}
  }

// ============ 事件绑定 ============

function bindEvents() {
  // 顶栏
  DOM.btnGameSettings().addEventListener('click', openGameSettings);
  DOM.btnSettings().addEventListener('click', openSettings);
  const btnTTS = document.getElementById('btnTTS');
  if (btnTTS) btnTTS.addEventListener('click', openTTS);
  const ttsModalClose = document.getElementById('ttsModalClose');
  if (ttsModalClose) ttsModalClose.addEventListener('click', closeTTS);
  const ttsModalOverlay = document.getElementById('ttsModalOverlay');
  if (ttsModalOverlay) ttsModalOverlay.addEventListener('click', closeTTS);
  DOM.btnExport().addEventListener('click', exportConversation);
  DOM.btnRestart().addEventListener('click', restartConversation);

  // 调试：桌面 ⇄ 移动 切换键（已在菜单栏）
  const btnDevMobile = document.getElementById('btnDevMobile');
  if (btnDevMobile) btnDevMobile.addEventListener('click', switchToMobile);

  // 侧栏展开/收起
  DOM.btnExpandSidebar().addEventListener('click', expandSidebar);
  DOM.btnCollapseSidebar().addEventListener('click', collapseSidebar);
  DOM.btnNewCharacterStrip().addEventListener('click', () => openCharacterModal());

  // 左侧栏角色列表操作
  DOM.btnNewCharacter().addEventListener('click', () => openCharacterModal());
  DOM.btnImportCharacter().addEventListener('click', () => DOM.characterFileInput().click());

  // 文件导入
  DOM.characterFileInput().addEventListener('change', handleCharacterImport);

  // 聊天输入
  DOM.messageInput().addEventListener('input', handleInputChange);
  DOM.messageInput().addEventListener('keydown', handleInputKeydown);
  DOM.btnSend().addEventListener('click', sendMessage);

  // 多媒体栏
  DOM.btnToggleAudio().addEventListener('click', toggleBGM);
  DOM.btnImageGenSettings().addEventListener('click', openImageGenSettingsInPanel);

  // 画廊翻页
  DOM.btnPrevImage().addEventListener('click', () => navigateGallery(-1));
  DOM.btnNextImage().addEventListener('click', () => navigateGallery(1));

  // 设置弹窗
  DOM.settingsModalClose().addEventListener('click', closeSettings);
  DOM.settingsModalOverlay().addEventListener('click', closeSettings);
  DOM.btnAddProvider().addEventListener('click', () => openProviderModal());
  DOM.btnResetTheme().addEventListener('click', resetTheme);
  DOM.btnSetDefaultTheme().addEventListener('click', setDefaultTheme);
  DOM.btnExportTheme().addEventListener('click', exportTheme);
  DOM.btnImportTheme().addEventListener('click', () => DOM.themeFileInput().click());
  DOM.themeFileInput().addEventListener('change', importTheme);

  // Theme preset selector (top bar)
  const themePresetSel = document.getElementById('themePresetSelect');
  if (themePresetSel) themePresetSel.addEventListener('change', switchThemePreset);

  // Theme mode toggle button (top bar, next to theme preset)
  const themeModeToggleBtn = document.getElementById('themeModeToggle');
  if (themeModeToggleBtn) themeModeToggleBtn.addEventListener('click', toggleThemeMode);

  // MVU 世界状态抽屉（Tier 3 闭环）
  const btnWorldState = document.getElementById('btnWorldState');
  if (btnWorldState) btnWorldState.addEventListener('click', () => {
    const d = document.getElementById('worldStateDrawer');
    if (d) d.classList.toggle('hidden');
    if (d && !d.classList.contains('hidden')) renderWorldStatePanel();
    const fb = document.getElementById('btnWorldStateFloat');
    if (fb) fb.classList.toggle('active', d && !d.classList.contains('hidden'));
  });
  const btnCloseWS = document.getElementById('btnCloseWorldStateDrawer');
  if (btnCloseWS) btnCloseWS.addEventListener('click', () => {
    const d = document.getElementById('worldStateDrawer');
    if (d) d.classList.add('hidden');
  });
  // 操作按钮（事件委托）
  const wsBody = document.getElementById('worldStateBody');
  if (wsBody) {
    wsBody.addEventListener('click', (e) => {
      const actBtn = e.target.closest('[data-ws-action]');
      if (!actBtn) return;
      const act = actBtn.dataset.wsAction;
      if (act === 'seed') seedWorldStateFromGreeting();
      else if (act === 'reprocess') reprocessWorldState();
      else if (act === 'clear') clearWorldState();
      else if (act === 'add') {
        const path = prompt('输入变量路径（RFC6902 风格，如 /contact/新角色/affection）：', '/contact/新角色');
        if (!path) return;
        const raw = prompt('输入值（字符串；若需数字请带单位或后续改）：', '');
        if (raw === null) return;
        setWorldVarByPath(path, raw);
      }
    });
    // 叶子值编辑（失焦/回车保存）
    wsBody.addEventListener('change', (e) => {
      const inp = e.target.closest('.ws-input');
      if (!inp) return;
      const path = decodeURIComponent(inp.dataset.path || '');
      let val = inp.value;
      if (inp.classList.contains('ws-num')) val = Number(val);
      setWorldVarByPath(path, val);
    });
  }

  // API Presets modal (btnOpenApiPresets may not exist in new tabbed layout)
  const btnOpenApiPresets = DOM.btnOpenApiPresets();
  if (btnOpenApiPresets) btnOpenApiPresets.addEventListener('click', openApiPresets);
  const apiPresetsCloseEl = DOM.apiPresetsClose();
  if (apiPresetsCloseEl) apiPresetsCloseEl.addEventListener('click', closeApiPresets);
  const apiPresetsOverlayEl = DOM.apiPresetsOverlay();
  if (apiPresetsOverlayEl) apiPresetsOverlayEl.addEventListener('click', closeApiPresets);
  const btnImportSTPresetEl = DOM.btnImportSTPreset();
  if (btnImportSTPresetEl) btnImportSTPresetEl.addEventListener('click', () => DOM.stPresetFile()?.click());
  const stPresetFileEl = DOM.stPresetFile();
  if (stPresetFileEl) stPresetFileEl.addEventListener('change', importSTPreset);
  const btnExportSTPresetEl = DOM.btnExportSTPreset();
  if (btnExportSTPresetEl) btnExportSTPresetEl.addEventListener('click', exportSTPreset);
  const btnDefaultChatPresetEl = DOM.btnDefaultChatPreset();
  if (btnDefaultChatPresetEl) btnDefaultChatPresetEl.addEventListener('click', setChatPresetDefault);
  const btnDeleteChatPresetEl = DOM.btnDeleteChatPreset();
  if (btnDeleteChatPresetEl) btnDeleteChatPresetEl.addEventListener('click', deleteChatPreset);
  const chatPresetSelectEl = DOM.chatPresetSelect();
  if (chatPresetSelectEl) chatPresetSelectEl.addEventListener('change', renderPresetParams);

  // 游戏设置弹窗
  DOM.gameSettingsClose().addEventListener('click', closeGameSettings);
  DOM.gameSettingsOverlay().addEventListener('click', closeGameSettings);
  DOM.btnSaveUser().addEventListener('click', saveUserProfile);
  DOM.btnNewUser().addEventListener('click', createNewUser);
  DOM.btnDeleteUser().addEventListener('click', deleteActiveUser);
  DOM.btnUploadAvatar().addEventListener('click', () => DOM.userAvatarFile().click());
  DOM.userAvatarFile().addEventListener('change', handleAvatarUpload);
  DOM.btnUploadPersonaAvatar().addEventListener('click', () => DOM.personaAvatarFile().click());
  DOM.personaAvatarFile().addEventListener('change', handlePersonaAvatarUpload);
  DOM.userSwitcher().addEventListener('change', switchActiveUser);
  // 角色弹窗
  DOM.characterModalClose().addEventListener('click', closeCharacterModal);
  DOM.characterModalOverlay().addEventListener('click', closeCharacterModal);
  DOM.btnCancelCharacter().addEventListener('click', closeCharacterModal);
  DOM.btnSaveCharacter().addEventListener('click', saveCharacter);
  DOM.btnFixCharacter().addEventListener('click', fixCharacterCard);
  DOM.btnAddWBEntry().addEventListener('click', addNewWBEntry);

  // 供应商弹窗
  DOM.providerModalClose().addEventListener('click', closeProviderModal);
  DOM.providerModalOverlay().addEventListener('click', closeProviderModal);
  DOM.btnCancelProvider().addEventListener('click', closeProviderModal);
  DOM.btnSaveProvider().addEventListener('click', saveProvider);
  DOM.btnFetchModels().addEventListener('click', fetchModels);
  // Proxy save button (may not exist yet when script runs, use delegation)
  document.addEventListener('click', (e) => {
    if (e.target.id === 'btnSaveProxy') saveProxyConfig();
    if (e.target.id === 'btnTTSTest') ttsTest();
    if (e.target.id === 'btnSaveTTSSettings') ttsSaveSettings();
    if (e.target.id === 'btnTTSStop') ttsStopPlayback();
    if (e.target.id === 'btnAddTTSProvider') ttsShowForm();
    if (e.target.id === 'btnSaveTTSProvider') ttsSaveProvider();
    if (e.target.id === 'btnCancelTTSProvider') ttsHideForm();
    if (e.target.id === 'btnFetchTTSModels') ttsFetchModels();
    if (e.target.id === 'btnFetchTTSVoices') ttsFetchVoices();
    if (e.target.classList && e.target.classList.contains('tts-vm-test')) ttsTestVoice(e.target.dataset.vm);
  });
  // TTS: 切换 API 格式或填写地址后，若已填 base_url 则自动拉取模型列表填充下拉
  document.addEventListener('change', (e) => {
    if (e.target.id === 'ttsApiFormat' || e.target.id === 'ttsProviderUrl') {
      const bu = document.getElementById('ttsProviderUrl');
      if (bu && bu.value.trim()) ttsFetchModels();
    }
    // 切换模型后，若已是百炼格式且填了地址，则按新模型重新拉取合法音色
    if (e.target.id === 'ttsProviderModel' || e.target.id === 'ttsProviderModelCustom') {
      const fmt = document.getElementById('ttsApiFormat');
      const bu = document.getElementById('ttsProviderUrl');
      if (fmt && fmt.value === 'bailian' && bu && bu.value.trim()) ttsFetchVoices();
    }
  });
  // Auto-fill default URL on provider type change
  DOM.providerType().addEventListener('change', () => {
    const type = DOM.providerType().value;
    const urlInput = DOM.providerUrl();
    if (type === 'xai' && (!urlInput.value || urlInput.value === 'http://localhost:11434')) {
      urlInput.value = 'https://api.x.ai/v1';
      urlInput.placeholder = 'https://api.x.ai/v1';
    } else if (type === 'ollama' && !urlInput.value) {
      urlInput.value = 'http://localhost:11434';
      urlInput.placeholder = 'http://localhost:11434';
    } else if (type === 'openai' && !urlInput.value) {
      urlInput.value = 'https://api.openai.com/v1';
      urlInput.placeholder = 'https://api.openai.com/v1';
    } else if (type === 'gemini' && (!urlInput.value || urlInput.value === 'http://localhost:11434' || urlInput.value === 'https://api.openai.com/v1')) {
      urlInput.value = 'https://generativelanguage.googleapis.com/v1beta/openai';
      urlInput.placeholder = 'https://generativelanguage.googleapis.com/v1beta/openai';
    }
  });

  // 选项卡切换
  DOM.chatTabBar().querySelectorAll('.chat-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchChatTab(btn.dataset.tab));
  });

  // 行动按钮点击（事件委托）
  DOM.messagesArea().addEventListener('click', (e) => {
    const btn = e.target.closest('.choice-option') || e.target.closest('.action-btn');
    if (btn) {
      e.preventDefault();
      const action = btn.dataset.action;
      if (action) {
        DOM.messageInput().value = action;
        DOM.messageInput().focus();
        sendMessage();
      }
      return;
    }
    // 消息删除按钮
    const delBtn = e.target.closest('.msg-delete-btn');
    if (delBtn) {
      e.preventDefault();
      deleteMessage(delBtn.dataset.id);
      return;
    }
    // 消息编辑按钮 → 弹出原始文本编辑窗口
    const editBtn = e.target.closest('.msg-edit-btn');
    if (editBtn) {
      e.preventDefault();
      showEditModal(editBtn.dataset.id);
      return;
    }
  });

  // 编辑弹窗关闭
  DOM.editModalClose().addEventListener('click', closeEditModal);
  DOM.editModalOverlay().addEventListener('click', closeEditModal);
  DOM.btnEditSave().addEventListener('click', saveEditModal);
  DOM.btnEditCancel().addEventListener('click', closeEditModal);

  // 手机弹出菜单（数据中心）+ 可拖动按钮
  initDraggablePhoneBtn();

  // MVU 世界状态悬浮按钮（可拖动）
  initDraggableWorldStateBtn();
  // MVU 世界状态弹窗（可拖动，标题栏拖动）
  initWorldStateDrawerDrag();
  // 点击抽屉外部关闭
  document.addEventListener('click', (e) => {
    const d = document.getElementById('worldStateDrawer');
    if (!d || d.classList.contains('hidden')) return;
    if (e.target.closest('#worldStateDrawer')) return;
    if (e.target.closest('#btnWorldState')) return;
    if (e.target.closest('#btnWorldStateFloat')) return;
    d.classList.add('hidden');
    const fb = document.getElementById('btnWorldStateFloat');
    if (fb) fb.classList.remove('active');
  });

  // Phone tab clicks
  const tabContainer = document.querySelector('.rpg-tab-container');
  if (tabContainer) {
    tabContainer.addEventListener('click', (e) => {
      const btn = e.target.closest('.rpg-tab-btn');
      if (!btn) return;
      const tab = btn.dataset.tab;
      setActiveTab(tab);
      const pages = { status: 'status', roster: 'roster', memory: 'memory', gallery: 'gallery' };
      const page = pages[tab];
      if (page) navigatePhoneTo(page);
    });
  }

  // Click outside phone popup to close
  document.addEventListener('click', (e) => {
    const popup = DOM.phonePopup();
    if (popup.classList.contains('hidden')) return;
    const trigger = DOM.btnPhoneFloat();
    if (!popup.contains(e.target) && e.target !== trigger && !trigger.contains(e.target)) {
      popup.classList.add('hidden');
    }
  });

  // Removed nav bar (close/home/back) — tab-based navigation

  // Reset phone float button position
  const btnResetPhonePos = document.getElementById('btnResetPhonePos');
  if (btnResetPhonePos) btnResetPhonePos.addEventListener('click', resetPhoneBtnPosition);

  // 头像点击 → 大图灯箱
  DOM.messagesArea().addEventListener('click', (e) => {
    const img = e.target.closest('.dialogue-avatar img');
    if (!img) return;
    e.preventDefault();
    showAvatarLightbox(img.src);
  });

  // 悬浮滚动按钮
  const btnScrollTop = document.getElementById('btnScrollTop');
  if (btnScrollTop) btnScrollTop.addEventListener('click', () => {
    DOM.messagesArea().scrollTo({ top: 0, behavior: 'smooth' });
  });
  const btnScrollEnd = document.getElementById('btnScrollEnd');
  if (btnScrollEnd) btnScrollEnd.addEventListener('click', () => {
    // ★ 立即贴底 + 多帧校正（content-visibility 占位高度会随真实渲染增长，一次 scrollTo 会停在半路）
    scrollToEndImmediately();
  });
  const btnScrollRound = document.getElementById('btnScrollRound');
  if (btnScrollRound) btnScrollRound.addEventListener('click', () => {
    scrollToLastMessageStart(); // ■ 直达最后一条消息开头（首尾消息不做缓存分片，定位准确）
  });

  // ★ 首尾消息必真实渲染，中间消息 content-visibility 分片
  initChatRenderChunking();

  // TTS Player Bar init
  ttsInitPlayerBar();

  // Load TTS settings into DOM on page init (so narrateOn / autoPlay reflect DB values)
  ttsLoadSettings();
}

// ============ 选项卡切换 ============

function switchChatTab(tab) {
  AppState.activeTab = tab;

  // Update tab buttons
  DOM.chatTabBar().querySelectorAll('.chat-tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });

  // Show/hide tab contents
  DOM.chatTabContent().classList.toggle('active', tab === 'chat');
  DOM.debugTabContent().classList.toggle('active', tab === 'debug');

  // When switching to chat tab, scroll to bottom
  if (tab === 'chat') {
    scrollToBottom();
  }
}

// ============ 侧边栏控制 ============

function toggleSidebar() {
  if (AppState.sidebarExpanded) {
    collapseSidebar();
  } else {
    expandSidebar();
  }
}

function expandSidebar() {
  AppState.sidebarExpanded = true;
  DOM.leftSidebar().classList.add('expanded');
}

function collapseSidebar() {
  AppState.sidebarExpanded = false;
  DOM.leftSidebar().classList.remove('expanded');
}

// AbortController for settings event listeners (prevents stacking on repeated opens)
let _settingsAbort = null;

function openSettings() {
  DOM.settingsModal().classList.remove('hidden');
  // Populate AI provider selectors
  populateAIProviderSelectors();
  // Load proxy config
  loadProxyConfig();
}

function openTTS() {
  document.getElementById('ttsModal').classList.remove('hidden');
  initTtsMasterSwitch();
  ttsLoadProviders();
  ttsLoadSettings();
}

function closeTTS() {
  document.getElementById('ttsModal').classList.add('hidden');
}

// ============ Proxy Settings ============
async function loadProxyConfig() {
  try {
    const resp = await request('/themes/settings/proxy');
    const el = document.getElementById('proxyEnabledToggle');
    if (el) el.checked = !!resp.enabled;
    const host = document.getElementById('proxyHost');
    if (host) host.value = resp.host || '127.0.0.1';
    const port = document.getElementById('proxyPort');
    if (port) port.value = resp.port || 9567;
    const auth = document.getElementById('proxyAuth');
    if (auth) auth.value = resp.auth || '';
  } catch { }
}

async function saveProxyConfig() {
  const enabled = document.getElementById('proxyEnabledToggle')?.checked || false;
  const host = document.getElementById('proxyHost')?.value?.trim() || '127.0.0.1';
  const port = parseInt(document.getElementById('proxyPort')?.value) || 9567;
  const auth = document.getElementById('proxyAuth')?.value?.trim() || '';
  try {
    await request('/themes/settings/proxy', {
      method: 'PUT',
      body: { enabled, host, port, auth }
    });
    const status = document.getElementById('proxyStatus');
    if (status) { status.textContent = '已保存'; setTimeout(() => status.textContent = '', 2000); }
  } catch (e) {
    alert('保存失败: ' + (e.message || ''));
  }
}


// Settings tab switching — called by onclick in HTML
function switchSettingsTab(tabName) {
  console.log('[Settings] switchSettingsTab:', tabName);

  // Hide ALL tab contents using inline style (highest priority, immune to CSS issues)
  document.querySelectorAll('.settings-tab-content').forEach(c => {
    c.style.display = 'none';
    c.classList.remove('active');
  });

  // Deactivate all tab buttons
  document.querySelectorAll('.settings-tab').forEach(t => {
    t.classList.remove('active');
  });

  // Activate the clicked tab button
  const tabBtn = document.querySelector(`.settings-tab[data-tab="${tabName}"]`);
  if (tabBtn) tabBtn.classList.add('active');

  // Show the corresponding content
  const targetId = 'tab' + tabName.charAt(0).toUpperCase() + tabName.slice(1);
  const targetEl = document.getElementById(targetId);
  console.log('[Settings] target:', targetId, 'exists:', !!targetEl);
  if (targetEl) {
    targetEl.style.display = 'block';
    targetEl.classList.add('active');
  }
}

async function populateAIProviderSelectors() {
  // Abort previous listeners if settings was opened before
  if (_settingsAbort) _settingsAbort.abort();
  _settingsAbort = new AbortController();
  const signal = _settingsAbort.signal;

  const mainSelect = document.getElementById('mainAIProvider');
  const butlerSelect = document.getElementById('butlerAIProvider');
  const painterSelect = document.getElementById('painterAIProvider');
  const mainInfo = document.getElementById('mainAIProviderInfo');
  const butlerInfo = document.getElementById('butlerAIProviderInfo');
  const painterInfo = document.getElementById('painterAIProviderInfo');
  const imageToggle = document.getElementById('imageEnabledToggle');
  const imageLabel = document.getElementById('imageEnabledLabel');
  if (!mainSelect || !butlerSelect) return;

  const providers = AppState.providers;
  const optHtml = providers.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');

  // Helper: show provider info below selector
  function showProviderInfo(infoEl, provider) {
    if (!infoEl) return;
    if (provider) {
      infoEl.textContent = `${provider.base_url || ''}  |  ${provider.model || ''}`;
    } else {
      infoEl.textContent = '';
    }
  }

  // Helper: get provider by ID
  function getProviderById(id) {
    return id ? providers.find(p => p.id === id) : null;
  }

  // Main AI selector
  const settings = await ThemeAPI.getSettings().catch(() => ({}));
  const mainId = settings.main_ai_provider_id || '';
  mainSelect.innerHTML = '<option value="">默认供应商</option>' + optHtml;
  mainSelect.value = mainId;
  showProviderInfo(mainInfo, getProviderById(mainId));

  // Butler AI selector
  const butlerId = settings.butler_provider_id || '';
  butlerSelect.innerHTML = '<option value="">与主 AI 相同</option>' + optHtml;
  butlerSelect.value = butlerId;
  // Show butler provider info, or fallback to "same as main" note
  if (butlerId) {
    showProviderInfo(butlerInfo, getProviderById(butlerId));
  } else {
    const mainP = getProviderById(mainId);
    butlerInfo.textContent = mainP ? `（跟随主 AI）${mainP.base_url} | ${mainP.model}` : '（跟随主 AI）';
  }

  // Use AbortController signal so all listeners are auto-removed on next openSettings()
  // Main AI change handler
  mainSelect.addEventListener('change', async () => {
    console.log('[Settings] >>> MAIN select changed, value=', mainSelect.value, 'id=', mainSelect.id);
    await ThemeAPI.saveSettings({ main_ai_provider_id: mainSelect.value });
    const p = getProviderById(mainSelect.value);
    showProviderInfo(mainInfo, p);
    // Update butler info if butler follows main
    if (!butlerSelect.value) {
      butlerInfo.textContent = p ? `（跟随主 AI）${p.base_url} | ${p.model}` : '（跟随主 AI）';
    }
    console.log('[Settings] main_ai_provider_id saved =', mainSelect.value, p?.name || '(default)');
    showToast('主 AI 供应商已更新', 'success');
  }, { signal });

  // Butler AI change handler
  butlerSelect.addEventListener('change', async () => {
    console.log('[Settings] >>> BUTLER select changed, value=', butlerSelect.value, 'id=', butlerSelect.id);
    await ThemeAPI.saveSettings({ butler_provider_id: butlerSelect.value });
    if (butlerSelect.value) {
      const p = getProviderById(butlerSelect.value);
      showProviderInfo(butlerInfo, p);
    } else {
      const mainP = getProviderById(mainSelect.value);
      butlerInfo.textContent = mainP ? `（跟随主 AI）${mainP.base_url} | ${mainP.model}` : '（跟随主 AI）';
    }
    console.log('[Settings] butler_provider_id saved =', butlerSelect.value, butlerSelect.value ? getProviderById(butlerSelect.value)?.name : '(same as main)');
    showToast('管家 AI 供应商已更新', 'success');
  }, { signal });

  // Painter AI selector
  if (painterSelect) {
    const painterId = settings.painter_provider_id || '';
    painterSelect.innerHTML = '<option value="">与管家 AI 相同</option>' + optHtml;
    painterSelect.value = painterId;
    if (painterId) {
      showProviderInfo(painterInfo, getProviderById(painterId));
    } else {
      const butlerP = getProviderById(butlerSelect.value) || getProviderById(mainSelect.value);
      painterInfo.textContent = butlerP ? `（跟随管家 AI）${butlerP.base_url} | ${butlerP.model}` : '（跟随管家 AI）';
    }
    painterSelect.addEventListener('change', async () => {
      await ThemeAPI.saveSettings({ painter_provider_id: painterSelect.value });
      if (painterSelect.value) {
        showProviderInfo(painterInfo, getProviderById(painterSelect.value));
      } else {
        const butlerP = getProviderById(butlerSelect.value) || getProviderById(mainSelect.value);
        painterInfo.textContent = butlerP ? `（跟随管家 AI）${butlerP.base_url} | ${butlerP.model}` : '（跟随管家 AI）';
      }
      showToast('画家 AI 供应商已更新', 'success');
    }, { signal });
  }

  // Image enabled toggle
  if (imageToggle) {
    const imgEnabled = settings.image_enabled !== 'false';
    imageToggle.checked = imgEnabled;
    imageLabel.textContent = imgEnabled ? '已开启' : '已关闭';
    imageToggle.addEventListener('change', async () => {
      const enabled = imageToggle.checked;
      imageLabel.textContent = enabled ? '已开启' : '已关闭';
      await ThemeAPI.saveSettings({ image_enabled: enabled ? 'true' : 'false' });
      showToast(enabled ? '生图功能已开启' : '生图功能已关闭', 'success');
    }, { signal });
  }

  // Load presets for both (pass AbortController signal)
  await loadPresetOptions('mainAIPreset', 'btnImportMainAIPreset', 'mainAIPresetFile', signal);
  await loadPresetOptions('butlerAIPreset', 'btnImportButlerAIPreset', 'butlerAIPresetFile', signal);

  // Edit preset buttons: open apiPresetsModal and auto-select the corresponding preset
  const btnEditMain = document.getElementById('btnEditMainAIPreset');
  if (btnEditMain) {
    btnEditMain.addEventListener('click', () => {
      const presetId = document.getElementById('mainAIPreset')?.value;
      if (!presetId) {
        showToast('请先选择一个预设', 'info');
        return;
      }
      _editPresetSource = 'mainAIPreset';
      openApiPresetsWithPreset(presetId);
    }, { signal });
  }
  const btnEditButler = document.getElementById('btnEditButlerAIPreset');
  if (btnEditButler) {
    btnEditButler.addEventListener('click', () => {
      const presetId = document.getElementById('butlerAIPreset')?.value;
      if (!presetId) {
        showToast('请先选择一个预设', 'info');
        return;
      }
      _editPresetSource = 'butlerAIPreset';
      openApiPresetsWithPreset(presetId);
    }, { signal });
  }
}

async function loadPresetOptions(selectId, btnId, fileInputId, signal) {
  const select = document.getElementById(selectId);
  const btn = document.getElementById(btnId);
  const fileInput = document.getElementById(fileInputId);
  if (!select) return;

  // Determine settings key based on selectId
  const settingKey = selectId === 'mainAIPreset' ? 'main_ai_preset_id' : 'butler_ai_preset_id';

  try {
    const presets = await PresetAPI.list();
    select.innerHTML = '<option value="">不使用预设</option>' +
      presets.map(p => `<option value="${p.id}">${escapeHtml(p.name || p.id)}</option>`).join('');

    // Restore previously saved preset selection
    const settings = await ThemeAPI.getSettings().catch(() => ({}));
    if (settings[settingKey]) {
      select.value = settings[settingKey];
    }
  } catch { }

  // Save selection on change (with AbortController if signal provided)
  const listenOpts = signal ? { signal } : undefined;
  select.addEventListener('change', async () => {
    const payload = {};
    payload[settingKey] = select.value;
    await ThemeAPI.saveSettings(payload).catch(() => { });
    console.log('[Settings]', settingKey, '=', select.value || '(none)');
  }, listenOpts);

  if (btn && fileInput) {
    btn.addEventListener('click', () => fileInput.click(), listenOpts);
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        const stData = JSON.parse(text);
        const parsed = parseSTPresetData(stData, file.name);
        const id = 'st-' + Date.now();
        await PresetAPI.save(id, {
          name: parsed.name,
          preset_type: 'chat',
          data: parsed.data,
          enabled_params: parsed.enabled_params,
          imported_from: file.name
        });
        await loadPresetOptions(selectId, btnId, fileInputId, signal);
        // Auto-select the newly imported preset
        select.value = id;
        const payload = {};
        payload[settingKey] = id;
        await ThemeAPI.saveSettings(payload).catch(() => { });
        showToast('预设已导入: ' + parsed.name + ' (参数' + parsed.paramCount + '项, 提示词' + parsed.promptCount + '条)', 'success');
      } catch (e) { showToast('导入失败: ' + e.message, 'error'); }
      fileInput.value = '';
    }, listenOpts);
  }
}

/**
 * Parse SillyTavern preset JSON into our internal format.
 * Shared by both settings panel import and API presets modal import.
 */
function parseSTPresetData(stData, fileName) {
  // Extract model parameters
  const paramKeys = ['temperature', 'top_p', 'top_k', 'repetition_penalty', 'frequency_penalty', 'presence_penalty', 'max_tokens', 'max_context', 'min_p', 'typical_p', 'top_a', 'tfs', 'epsilon_cutoff', 'eta_cutoff', 'rep_pen_range', 'encoder_repetition_penalty', 'no_repeat_ngram_size', 'penalize_nl', 'num_beams', 'do_sample', 'seed', 'min_length', 'num_return_sequences'];
  const data = {};
  const enabledParams = [];
  paramKeys.forEach(k => { if (stData[k] !== undefined) { data[k] = stData[k]; enabledParams.push(k); } });

  // Extract system prompts from 'prompts' array (ST v1.12+ format) or legacy 'prompt_order'
  const systemPrompts = [];
  const promptSource = stData.prompts || stData.prompt_order || [];

  if (Array.isArray(promptSource)) {
    promptSource.forEach(entry => {
      if (entry.marker) return; // Skip marker entries (placeholders)
      const text = (entry.content || '').trim();
      if (!text) return; // Skip empty content

      systemPrompts.push({
        name: entry.name || (entry.identifier || '').substring(0, 12) || '提示词',
        content: text,
        role: entry.role || 'system',
        enabled: entry.enabled !== false,
        injection_position: entry.injection_position ?? 0,
        injection_depth: entry.injection_depth ?? 0,
        forbid_overrides: entry.forbid_overrides || false,
        system_prompt: entry.system_prompt || false
      });
    });
  }
  if (systemPrompts.length > 0) data.system_prompts = systemPrompts;

  const name = (fileName || '').replace(/\.json$/, '').replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, '_') || 'Imported';

  return {
    name,
    data,
    enabled_params: enabledParams.length > 0 ? enabledParams : ['temperature', 'top_p', 'max_tokens'],
    paramCount: Object.keys(data).filter(k => k !== 'system_prompts').length,
    promptCount: systemPrompts.length
  };
}

function closeSettings() {
  DOM.settingsModal().classList.add('hidden');
}

// ============ 游戏设置弹窗 ============

async function openGameSettings() {
  // 加载所有用户
  try {
    const users = await UserAPI.list();
    AppState.allUsers = users;
    const active = users.find(u => u.is_active) || users[0] || { id: 0, name: '我', avatar: '', intro: '' };
    AppState.userProfile = active;
    AppState.editingUserId = active.id;
    renderUserSwitcher();
    fillUserForm(active);
  } catch { /* ignore */ }

  DOM.gameSettingsModal().classList.remove('hidden');
}

function closeGameSettings() {
  DOM.gameSettingsModal().classList.add('hidden');
}

function fillUserForm(user) {
  DOM.userNameInp().value = user.name || '我';
  DOM.userIntroInp().value = user.intro || '';
  DOM.userAvatarPreview().innerHTML = user.avatar
    ? `<img src="${escapeHtml(user.avatar)}" alt="">`
    : `<span>${escapeHtml((user.name || '我').charAt(0))}</span>`;
  // Persona (in-game role-play identity)
  DOM.personaNameInp().value = user.persona_name || '';
  DOM.personaAvatarPreview().innerHTML = user.persona_avatar
    ? `<img src="${escapeHtml(user.persona_avatar)}" alt="">`
    : `<span>${escapeHtml((user.persona_name || '角').charAt(0))}</span>`;
}

function renderUserSwitcher() {
  const sel = DOM.userSwitcher();
  sel.innerHTML = AppState.allUsers.map(u =>
    `<option value="${u.id}" ${u.is_active ? 'selected' : ''}>${escapeHtml(u.name)} ${u.is_active ? '(当前)' : ''}</option>`
  ).join('');
}

async function saveUserProfile() {
  try {
    const data = {
      name: DOM.userNameInp().value.trim() || '我',
      intro: DOM.userIntroInp().value.trim(),
      persona_name: DOM.personaNameInp().value.trim(),
    };
    if (AppState.editingUserId && AppState.allUsers.find(u => u.id === AppState.editingUserId)) {
      await UserAPI.update(AppState.editingUserId, data);
    }
    showToast('已保存', 'success');
    await openGameSettings(); // refresh
  } catch (err) {
    showToast('保存失败: ' + err.message, 'error');
  }
}

async function createNewUser() {
  const name = prompt('输入新用户名：');
  if (!name || !name.trim()) return;
  try {
    await UserAPI.create({ name: name.trim() });
    await openGameSettings();
    showToast('用户已创建', 'success');
  } catch (err) {
    showToast('创建失败: ' + err.message, 'error');
  }
}

async function deleteActiveUser() {
  const user = AppState.allUsers.find(u => u.id === AppState.editingUserId);
  if (!user) return;
  if (user.is_active) { showToast('请先切换到其他用户再删除', 'warning'); return; }
  if (!confirm(`确定删除用户「${user.name}」？`)) return;
  try {
    await UserAPI.delete(user.id);
    await openGameSettings();
    showToast('已删除', 'success');
  } catch (err) {
    showToast('删除失败: ' + err.message, 'error');
  }
}

async function switchActiveUser() {
  const id = parseInt(DOM.userSwitcher().value);
  if (!id) return;
  try {
    const user = await UserAPI.activate(id);
    AppState.userProfile = user;

    // Reload current conversation with new user context
    if (AppState.currentCharacter && AppState.currentConversation) {
      await loadConversation(AppState.currentConversation.id);
    } else if (AppState.currentCharacter) {
      // Character selected but no conversation → auto-create
      const result = await ConversationAPI.create({
        character_id: AppState.currentCharacter.id,
      });
      if (result.save_id) AppState._currentSaveId = result.save_id;
      AppState.conversations = await ConversationAPI.list();
      await loadConversation(result.id);
    }

    showToast(`已切换到「${user.name}」`, 'success');
  } catch (err) {
    showToast('切换失败: ' + err.message, 'error');
  }
}

async function handleAvatarUpload() {
  const file = DOM.userAvatarFile().files[0];
  if (!file) return;
  if (!AppState.editingUserId) { showToast('请先保存用户', 'warning'); return; }
  try {
    const user = await UserAPI.uploadAvatar(AppState.editingUserId, file);
    AppState.userProfile = user;
    DOM.userAvatarPreview().innerHTML = `<img src="${escapeHtml(user.avatar)}" alt="">`;
    showToast('头像已上传', 'success');
  } catch (err) {
    showToast('上传失败: ' + err.message, 'error');
  }
  DOM.userAvatarFile().value = '';
}

async function handlePersonaAvatarUpload() {
  const file = DOM.personaAvatarFile().files[0];
  if (!file) return;
  if (!AppState.editingUserId) { showToast('请先保存用户', 'warning'); return; }
  try {
    const user = await UserAPI.uploadPersonaAvatar(AppState.editingUserId, file);
    AppState.userProfile = user;
    DOM.personaAvatarPreview().innerHTML = `<img src="${escapeHtml(user.persona_avatar)}" alt="">`;
    showToast('扮演角色头像已上传', 'success');
  } catch (err) {
    showToast('上传失败: ' + err.message, 'error');
  }
  DOM.personaAvatarFile().value = '';
}

async function saveSystemPrompt() {
  try {
    const prompt = DOM.systemPromptEditor().value;
    await ThemeAPI.saveSettings({ global_system_prompt: prompt });
    showToast('主 AI 提示词已保存', 'success');
  } catch (err) {
    showToast('保存失败: ' + err.message, 'error');
  }
}

async function saveCardFixerPrompt() {
  try {
    const prompt = DOM.cardFixerPromptEditor().value;
    await ThemeAPI.saveSettings({ card_fixer_prompt: prompt });
    showToast('修卡提示词已保存', 'success');
  } catch (err) {
    showToast('保存失败: ' + err.message, 'error');
  }
}

async function saveMemoryAgentPrompt() {
  try {
    const prompt = DOM.memoryAgentPromptEditor().value;
    await ThemeAPI.saveSettings({ memory_agent_prompt: prompt });
    showToast('副 AI 记忆提示词已保存', 'success');
  } catch (err) {
    showToast('保存失败: ' + err.message, 'error');
  }
}

async function loadSystemPrompt() {
  try {
    const res = await fetch('/api/settings/system-prompt');
    const data = await res.json();
    DOM.systemPromptEditor().value = data.prompt || '';
    showToast('已加载当前提示词', 'success');
  } catch (err) {
    showToast('读取失败: ' + err.message, 'error');
  }
}

async function saveSystemPrompt() {
  try {
    const prompt = DOM.systemPromptEditor().value;
    await fetch('/api/settings/system-prompt', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt }),
    });
    showToast('主提示词已保存', 'success');
  } catch (err) {
    showToast('保存失败: ' + err.message, 'error');
  }
}

async function resetSystemPrompt() {
  if (!confirm('确定恢复为默认提示词吗？当前修改将丢失。')) return;
  try {
    // Delete the custom value — chat.js will use hardcoded default
    await fetch('/api/settings/system-prompt', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: '' }),
    });
    DOM.systemPromptEditor().value = '';
    showToast('已恢复默认提示词', 'success');
  } catch (err) {
    showToast('重置失败: ' + err.message, 'error');
  }
}

// ============ 竖条头像列表 ============

function renderStripAvatars() {
  const container = DOM.stripAvatars();

  if (AppState.characters.length === 0) {
    container.innerHTML = '';
    return;
  }

  const saveId = getCurrentSaveId();
  container.innerHTML = AppState.characters.map(char => {
    const isActive = AppState.currentCharacter && AppState.currentCharacter.id === char.id;

    // Priority: roster avatar > char.avatar > firstChar
    let inner = escapeHtml(firstCharNoSymbol(char.name));
    // 1. Check roster (管家AI生成的头像)
    const rosterEntry = AppState.characterRoster[char.name];
    if (rosterEntry && rosterEntry.avatar && rosterEntry.avatar !== 'pending' && rosterEntry.avatar !== '') {
      const avatarPath = rosterEntry.avatar.startsWith('/') ? rosterEntry.avatar : '/api/saves/' + saveId + '/avatar/' + encodeURIComponent(char.name);
      inner = `<img src="${escapeHtml(avatarPath)}" alt="${escapeHtml(char.name)}">`;
    }
    // 2. Check char.avatar (角色卡自带头像)
    else if (char.avatar) {
      inner = `<img src="${escapeHtml(char.avatar)}" alt="${escapeHtml(char.name)}">`;
    }

    return `
      <div class="strip-avatar ${isActive ? 'active' : ''}" data-id="${char.id}" title="${escapeHtml(char.name)}">
        ${inner}
      </div>
    `;
  }).join('');

  // 绑定点击事件 — strip click: select + collapse sidebar
  container.querySelectorAll('.strip-avatar').forEach(el => {
    el.addEventListener('click', () => {
      // selectCharacter with collapseAfter=true (default) collapses the sidebar
      selectCharacter(el.dataset.id, { collapseAfter: true });
    });
  });
}

// ============ 游戏列表渲染（折叠面板） ============

function renderCharacterList() {
  const container = DOM.characterList();

  if (AppState.characters.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <p>暂无角色</p>
        <button class="btn btn-sm" id="btnImportCharacterEmpty">导入角色卡</button>
      </div>
    `;
    const btn = document.getElementById('btnImportCharacterEmpty');
    if (btn) {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        document.getElementById('characterFileInput')?.click();
      });
    }
    return;
  }

  // Build character list with conversation sub-menus
  const convsByChar = {};
  AppState.conversations.forEach(c => {
    if (!convsByChar[c.character_id]) convsByChar[c.character_id] = [];
    convsByChar[c.character_id].push(c);
  });

  container.innerHTML = AppState.characters.map(char => {
    const isActive = AppState.currentCharacter && AppState.currentCharacter.id === char.id;
    const charConvs = convsByChar[char.id] || [];
    const currentConvId = AppState.currentConversation?.id;
    const avatarHtml = char.avatar
      ? `<img src="${escapeHtml(char.avatar)}" alt="${escapeHtml(char.name)}" class="character-avatar">`
      : `<div class="character-avatar-placeholder">${escapeHtml(firstCharNoSymbol(char.name))}</div>`;

    // Build conversation list items with delete/export buttons
    let convListHtml = '';
    if (charConvs.length > 0) {
      convListHtml = charConvs.map(c => {
        const saveId = c.save_id || '';
        const convTitle = escapeHtml(c.save_id || c.title || 'Untitled');
        return `
        <div class="char-conv-item ${c.id === currentConvId ? 'active' : ''}" data-conv-id="${c.id}" data-save-id="${saveId}">
          <span class="conv-item-label" data-action="select-conv" data-conv-id="${c.id}">${convTitle}</span>
          <span class="conv-item-actions">
            <button class="conv-export-md" data-save-id="${saveId}" title="导出MD">📥</button>
            <button class="conv-delete" data-conv-id="${c.id}" data-save-id="${saveId}" title="删除">✕</button>
          </span>
        </div>`;
      }).join('');
    }
    convListHtml += `<div class="char-conv-item new-conv" data-action="new-conv" data-char-id="${char.id}">+ 新对话</div>`;

    return `
      <div class="character-item ${isActive ? 'active' : ''}" data-id="${char.id}" data-action="toggle-char">
        <div class="character-info">
          <div class="character-name">${escapeHtml(char.name)}</div>
        </div>
        <div class="character-actions">
          <button class="icon-btn-sm char-edit" data-id="${char.id}" title="编辑">✎</button>
          <button class="icon-btn-sm char-delete" data-id="${char.id}" title="删除">✕</button>
        </div>
      </div>
      <div class="char-conv-list ${AppState.expandedCharId === char.id ? 'show' : ''}" data-char-convs="${char.id}">
        ${convListHtml}
      </div>
    `;
  }).join('');

  // Event delegation: single click handler on container (no per-element addEventListener)
  // This avoids N addEventListener calls per renderCharacterList() which causes layout thrash
  // We use a data-render-id to avoid double-binding on re-render
  const renderId = Date.now();
  container.dataset.renderId = renderId;
  if (!container._delegatedClickBound) {
    container._delegatedClickBound = true;
    container.addEventListener('click', async (e) => {
      // Character card click
      const charItem = e.target.closest('.character-item');
      if (charItem && !e.target.closest('.character-actions')) {
        const charId = charItem.dataset.id;
        const isActive = AppState.currentCharacter && AppState.currentCharacter.id === charId;

        if (!isActive) {
          await selectCharacter(charId, { collapseAfter: false });
        }

        // Accordion: collapse all other conv lists, toggle the clicked one
        container.querySelectorAll('.char-conv-list').forEach(list => {
          if (list.dataset.charConvs !== charId) list.classList.remove('show');
        });
        const convList = container.querySelector(`[data-char-convs="${charId}"]`);
        if (convList) {
          convList.classList.toggle('show');
          AppState.expandedCharId = convList.classList.contains('show') ? charId : null;
        }
        return;
      }

      // Select conversation
      const convLabel = e.target.closest('.conv-item-label[data-action="select-conv"]');
      if (convLabel) {
        e.stopPropagation();
        await loadConversation(convLabel.dataset.convId);
        collapseSidebar();
        return;
      }

      // New conversation
      const newConvBtn = e.target.closest('.char-conv-item[data-action="new-conv"]');
      if (newConvBtn) {
        e.stopPropagation();
        const charId = newConvBtn.dataset.charId;
        try {
          const result = await ConversationAPI.create({ character_id: charId });
          if (result.save_id) AppState._currentSaveId = result.save_id;
          await loadConversation(result.id);
          collapseSidebar();
        } catch (err) {
          console.error('[NewConv] Failed:', err);
          showToast('创建对话失败', 'error');
        }
        return;
      }

      // Delete conversation/save
      const convDeleteBtn = e.target.closest('.conv-delete');
      if (convDeleteBtn) {
        e.stopPropagation();
        const convId = convDeleteBtn.dataset.convId;
        const saveId = convDeleteBtn.dataset.saveId;
        if (!confirm('确定删除该存档？对话记录和缓存文件将被永久删除。')) return;
        try {
          if (saveId) await SavesAPI.delete(saveId);
          else await ConversationAPI.delete(convId);
          showToast('存档已删除', 'success');
          if (AppState.currentConversation?.id === convId) {
            AppState.currentConversation = null;
            AppState.messages = [];
      AppState.totalMessages = 0;
      AppState._messagesFullyLoaded = false;
      renderLoadEarlierBar();
            AppState.userStatus = {};
            AppState.galleryImages = [];
            AppState.cgGallery = [];
            AppState._currentSaveId = '';
            DOM.welcomeScreen().classList.remove('hidden');
            DOM.chatContainer().classList.add('hidden');
            DOM.conversationTitle().textContent = '选择角色开始对话';
            renderStatusBar();
            renderGallery();
          }
          AppState.conversations = await ConversationAPI.list();
          renderCharacterList();
        } catch (err) {
          console.error('[DeleteSave] Failed:', err);
          showToast('删除存档失败: ' + err.message, 'error');
        }
        return;
      }

      // Export MD
      const exportBtn = e.target.closest('.conv-export-md');
      if (exportBtn) {
        e.stopPropagation();
        const saveId = exportBtn.dataset.saveId;
        if (!saveId) { showToast('无存档ID', 'error'); return; }
        try {
          showToast('正在导出...', 'info');
          const blob = await SavesAPI.exportMD(saveId);
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `${saveId}.md`;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
          showToast('导出成功', 'success');
        } catch (err) {
          console.error('[ExportMD] Failed:', err);
          showToast('导出失败: ' + err.message, 'error');
        }
        return;
      }

      // Edit character
      const editBtn = e.target.closest('.char-edit');
      if (editBtn) {
        e.stopPropagation();
        openCharacterModal(editBtn.dataset.id);
        return;
      }

      // Delete character
      const deleteBtn = e.target.closest('.char-delete');
      if (deleteBtn) {
        e.stopPropagation();
        deleteCharacter(deleteBtn.dataset.id);
        return;
      }
    });
  }
}

// ============ 选择角色 & 开始对话 ============

async function selectCharacter(characterId, opts = {}) {
  const { collapseAfter = true } = opts;
  try {
    const character = await CharacterAPI.get(characterId);
    AppState.currentCharacter = character;
    initUserStatus(character);

    // Load conversations for this character
    const conversations = await ConversationAPI.list();
    AppState.conversations = conversations;
    const charConvs = conversations.filter(c => c.character_id === characterId);

    if (charConvs.length === 1) {
      // Single conversation: auto-select
      await loadConversation(charConvs[0].id);
    } else if (charConvs.length > 1) {
      // Multiple: load the most recently updated
      const latest = charConvs.sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''))[0];
      await loadConversation(latest.id);
    } else {
      // None: auto-create
      const result = await ConversationAPI.create({
        character_id: characterId,
      });
      if (result.save_id) AppState._currentSaveId = result.save_id;
      AppState.conversations = await ConversationAPI.list();
      await loadConversation(result.id);
    }

    DOM.conversationTitle().textContent = character.name;
    DOM.welcomeScreen().classList.add('hidden');
    DOM.chatContainer().classList.remove('hidden');

    renderStripAvatars();
    renderCharacterList();
    renderStatusBar();

    if (collapseAfter) collapseSidebar();
  } catch (err) {
    console.error('[SelectCharacter] 失败:', err);
    showToast('加载角色失败', 'error');
  }
}

// ============ 角色状态初始化 ============

function initUserStatus(character) {
  // 状态栏只显示AI输出中 ### status 段落的游戏状态（如生命值、好感度等）
  // 不再从角色卡读取性格/心情/位置等角色设定字段
  // 选择角色时先清空状态，然后尝试从存档文件夹加载已有状态
  AppState.userStatus = {};
  // Try loading from save folder
  const saveId = getCurrentSaveId();
  if (saveId) {
    request('/saves/' + saveId + '/status').then(resp => {
      if (resp && Object.keys(resp).length > 0) {
        AppState.userStatus = resp;
        renderStatusBar();
      }
    }).catch(() => { });
  }
}

// ============ 加载对话 & 消息 ============

async function loadConversation(conversationId) {
  // Stop any active gallery polling from previous conversation
  stopGalleryPoll();

  try {
    // 长聊天折叠：初始只加载最新 100 条（节约资源），向上翻页时按需加载更早
    const [conv, msgRes] = await Promise.all([
      ConversationAPI.get(conversationId),
      MessageAPI.loadLatest(conversationId, 100),
    ]);

    AppState.currentConversation = conv;
    AppState.messages = msgRes.messages;
    AppState.totalMessages = msgRes.total;
    AppState._messagesFullyLoaded = msgRes.total <= msgRes.messages.length;
    AppState.roundCounter = 0;

    // 先加载配置（名册、颜色、存档ID），再渲染消息
    // 切存档/切对话先把 CG 状态清零：否则上一局的 CG 会留在 AppState.cgGallery 里继续当背景
    // （本对话还没有存档记录、或画廊请求失败时，旧画廊会被误当成"本局背景"）
    AppState.cgGallery = [];
    AppState._currentSaveId = '';
    try {
      const saves = await SavesAPI.list().catch(() => []);
      const save = saves.find(s => s.conversation_id === conv.id);
      if (save) {
        AppState._currentSaveId = save.id;
        // 加载 CG 画廊（只认本存档自己的画廊）
        const cgResp = await request('/saves/' + save.id + '/cg-gallery').catch(() => null);
        if (cgResp && Array.isArray(cgResp.gallery)) {
          AppState.cgGallery = cgResp.gallery;
        }
      }
    } catch { }
    await loadCharacterColors();

    // 渲染画廊（CG + 普通图片）
    renderGallery();

    // 切换对话时清空调试面板
    clearDebugPanel();

    renderMessages();
    renderLoadEarlierBar();

    // 从最新消息恢复状态栏
    extractStatusFromMessages(AppState.messages);

    // 恢复 MVU 世界状态（engine 卡）
    AppState.worldStateLoaded = false;
    loadWorldState().catch(e => console.error('[WorldState] load:', e));

    // 重置 token 统计，从后端加载（包含系统提示词+角色卡+预设的完整统计）
    AppState.tokenContext = 0;
    AppState.tokenTotal = 0;
    AppState.systemTokens = 0;
    updateTokenCounter();
    loadTokenStats();  // async, updates UI when ready

    scrollToBottom();
  } catch (err) {
    console.error('[LoadConversation] 失败:', err);
    showToast('加载对话失败', 'error');
  }
}

// ============ 消息渲染 ============

function renderMessages() {
  const area = DOM.messagesArea();
  const renderedIds = new Set();
  area.querySelectorAll('.story-block').forEach(el => renderedIds.add(el.dataset.id));

  // Track which messages are new (not yet in DOM)
  const newMessages = AppState.messages.filter(m => !renderedIds.has(m.id));

  if (newMessages.length === 0 && AppState.messages.length === area.querySelectorAll('.story-block').length) {
    return; // Nothing changed
  }

  // ★ 长聊天折叠：已加载消息全部渲染（初始仅最新 100 条，向上翻页按需加载更早 —— 分页本身控制总量，
  //   不再做 MAX_VISIBLE_MSGS 截断，否则用户加载的更早消息会被截掉看不到）
  area.innerHTML = '';
  AppState.roundCounter = 0;
  AppState.messages.forEach((msg) => {
    appendSafeMessage(area, msg);
  });
}

/**
 * 顶部"加载更早消息"条（长聊天折叠）：还有更早消息时显示，点击按需加载前 100 条
 */
function renderLoadEarlierBar() {
  // 移除旧条
  const old = document.querySelector('.load-earlier-bar');
  if (old) old.remove();
  // 无对话 / 已全部加载 → 不显示
  if (!AppState.currentConversation || AppState._messagesFullyLoaded) return;
  const total = AppState.totalMessages || 0;
  const loaded = AppState.messages.length;
  if (loaded >= total) return;
  const remain = Math.max(0, total - loaded);
  const bar = document.createElement('div');
  bar.className = 'load-earlier-bar';
  bar.innerHTML = `<button class="load-earlier-btn" onclick="loadEarlierMessages()" title="向上翻看更早的聊天记录">
    ↑ 加载更早消息（还有 ${remain} 条）
  </button>`;
  DOM.messagesArea().prepend(bar);
}

/** 加载更早 100 条并插入消息流顶部（保持当前阅读位置不跳动） */
async function loadEarlierMessages() {
  if (!AppState.currentConversation || !AppState.messages.length || AppState._messagesFullyLoaded) return;
  const area = DOM.messagesArea();
  // 记录当前最顶一条可见消息的锚点（加载更多后保持其视口位置）
  const anchorEl = area.querySelector('.story-block');
  const anchorId = anchorEl ? anchorEl.dataset.id : null;
  const offsetBefore = anchorEl
    ? anchorEl.getBoundingClientRect().top - area.getBoundingClientRect().top : 0;

  const beforeId = AppState.messages[0].id;
  try {
    const res = await MessageAPI.loadEarlier(AppState.currentConversation.id, beforeId, 100);
    if (!res.messages.length) {
      AppState._messagesFullyLoaded = true;
      renderLoadEarlierBar();
      return;
    }
    AppState.messages = [...res.messages, ...AppState.messages];
    AppState.totalMessages = res.total;
    if (res.messages.length < 100) AppState._messagesFullyLoaded = true; // 已到最早
    renderMessages();
    renderLoadEarlierBar();
    // 恢复锚点：让原来的第一条消息回到加载前的位置
    if (anchorId) {
      const anchor = area.querySelector(`.story-block[data-id="${anchorId}"]`);
      if (anchor) {
        area.scrollTop += (anchor.getBoundingClientRect().top - area.getBoundingClientRect().top) - offsetBefore;
      }
    }
  } catch (err) {
    console.error('[LoadEarlier] 加载更早消息失败:', err);
    showToast('加载更早消息失败', 'error');
  }
}

/**
 * 安全追加单条消息：单条渲染异常只跳过该条（console.error），不中断整体渲染。
 * ★ 防崩溃：历史/流式消息中若某条数据异常（formatted 结构损坏、超长文本、特殊字符等），
 *   之前会抛错中断整个 renderMessages → 后续（尤其最新几条）全部不显示
 */
function appendSafeMessage(area, msg) {
  try {
    if (msg.role === 'user') AppState.roundCounter++;
    const roundNum = msg.role === 'user' ? AppState.roundCounter : AppState.roundCounter;
    area.appendChild(createMessageElement(msg, roundNum));
  } catch (err) {
    console.error('[Render] 单条消息渲染失败，已跳过（不影响其他消息）:', msg && msg.id, err);
  }
}

function createMessageElement(msg, roundNum) {
  const div = document.createElement('div');
  const isHidden = !!msg.hidden;
  div.className = `story-block ${msg.role}${isHidden ? ' is-hidden' : ''}`;
  div.dataset.id = msg.id;
  div.dataset.round = roundNum || 0;

  // 解析 formatted
  let formatted = null;
  if (msg.formatted && typeof msg.formatted === 'object') {
    formatted = msg.formatted;
  } else {
    try {
      formatted = typeof msg.formatted === 'string' ? JSON.parse(msg.formatted) : null;
    } catch { /* ignore */ }
  }
  // Handle double-nested format: { cleanText, formatted: { segments, mood, ... } }
  // This was caused by a bug where parseAIResponse's full return was stored instead of just .formatted
  if (formatted && formatted.formatted && typeof formatted.formatted === 'object' && formatted.formatted.segments) {
    formatted = formatted.formatted;
  }

  if (msg.role === 'user') {
    div.innerHTML = renderUserBlock(msg.content, msg.created_at, roundNum, isHidden)
      + `<div class="msg-actions">
          <button class="msg-btn msg-edit-btn" data-id="${msg.id}" data-action="edit" title="编辑">✎</button>
          <button class="msg-btn msg-delete-btn" data-id="${msg.id}" data-action="delete" title="删除">✕</button>
        </div>`;
  } else {
    div.innerHTML = renderAIBlock(formatted, msg.content, msg.created_at, isHidden)
      + `<div class="msg-actions">
          <button class="msg-btn msg-edit-btn" data-id="${msg.id}" data-action="edit" title="编辑">✎</button>
          <button class="msg-btn msg-delete-btn" data-id="${msg.id}" data-action="delete" title="删除">✕</button>
        </div>`;
    // 注意：仅实时消息写入调试面板，历史加载不追加（避免DOM累积导致浏览器卡死）
  }

  return div;
}

/**
 * 渲染用户消息块 —— 简洁的行动标签风格
 */
function renderUserBlock(content, timeStr, roundNum, isHidden) {
  // Replace {{user}} and {{char}} macros with current user/character names
  const processedContent = replaceMacros(content);
  return `
    <div class="user-action${isHidden ? ' hidden-msg' : ''}">
      <span class="user-action-round">#${roundNum}</span>
      <span class="user-action-icon">▷</span>
      <span class="user-action-text">${renderInlineImages(processedContent)}</span>
      <span class="user-action-time">${formatTime(timeStr)}</span>
      ${isHidden ? '<span class="hidden-badge">已隐藏</span>' : ''}
    </div>
  `;
}

/**
 * Strip ### header sections (mood, portrait, actions, status, etc.) from raw AI text,
 * keeping only story and dialogue content. Used when formatted.segments is empty
 * but the raw content contains meta sections that shouldn't be rendered as narration.
 */
function stripMetaSections(text) {
  if (!text) return text;
  const sections = text.split(/\n###\s+/);
  const storyParts = [];
  for (const section of sections) {
    const firstLine = section.split('\n')[0]?.trim() || '';
    const header = firstLine.replace(/^###\s*/, '').toLowerCase();
    // Keep only story/dialog content; skip meta sections
    if (header.startsWith('mood') || header.startsWith('status') || header.startsWith('summarize')) {
      // These sections contain only metadata values, skip entirely
    } else if (header.startsWith('portrait') || header.startsWith('cg') || header.startsWith('image')) {
      // Check if there's content after key:value lines (AI sometimes puts story after portrait)
      const body = section.slice(section.indexOf('\n') + 1).trim();
      const remainderLines = [];
      let inRemainder = false;
      for (const line of body.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        if (inRemainder) { remainderLines.push(line); continue; }
        const ci = t.indexOf('：');
        const ei = t.indexOf(':');
        const idx = ci >= 0 ? ci : ei >= 0 ? ei : -1;
        if (idx > 0 && idx < t.length - 1) {
          // key:value line, skip
        } else {
          inRemainder = true;
          remainderLines.push(line);
        }
      }
      if (remainderLines.join('\n').trim()) {
        storyParts.push(remainderLines.join('\n').trim());
      }
    } else if (header.startsWith('actions')) {
      // Skip actions section (handled separately via formatted.actions)
    } else if (header.startsWith('story') || header.startsWith('dialog')) {
      // Keep story/dialog content
      const body = section.slice(section.indexOf('\n') + 1).trim();
      if (body) storyParts.push(body);
    } else {
      // Unrecognized header or no header (first section) — keep as-is
      const content = header ? section.slice(section.indexOf('\n') + 1).trim() : section.trim();
      if (content) storyParts.push(content);
    }
  }
  return storyParts.join('\n\n').trim();
}

// ─────────────────────────────────────────────────────────────
// 嵌入式标记（HTML / 自定义 XML）渲染支持
// 当主窗口最终输出含标记内容时，由代码识别并以内嵌网页(iframe)渲染
// ─────────────────────────────────────────────────────────────

// 自增 id 计数，确保每条内嵌 iframe 有唯一 id（用于主题切换 / 自适应高度同步）
let xmlEmbedCounter = 0;

// XML 内嵌网页专属样式（明暗双主题，随父窗口主题切换）
const XML_EMBED_CSS = `
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 14px 16px 18px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", Roboto, Helvetica, Arial, sans-serif;
  font-size: 14px;
  line-height: 1.75;
  background: var(--bg);
  color: var(--fg);
  white-space: pre-wrap;
  word-break: break-word;
  transition: background .25s ease, color .25s ease;
}
body.theme-dark {
  --bg:#15161d; --panel:#1d1f29; --fg:#e9eef8; --muted:#98a2b6;
  --accent:#7c9eff; --hl-bg:rgba(124,158,255,.18); --hl-fg:#c2d4ff;
  --border:rgba(255,255,255,.09); --sec-glow:rgba(124,158,255,.06);
}
body.theme-light {
  --bg:#f3f4f8; --panel:#ffffff; --fg:#1b1e27; --muted:#5b6273;
  --accent:#3a6df0; --hl-bg:rgba(58,109,240,.14); --hl-fg:#1f4fd0;
  --border:rgba(0,0,0,.09); --sec-glow:rgba(58,109,240,.05);
}
.xml-section {
  display: block;
  background: var(--panel);
  border: 1px solid var(--border);
  border-left: 3px solid var(--accent);
  border-radius: 10px;
  padding: 10px 14px 12px;
  margin: 10px 0;
  box-shadow: 0 2px 12px var(--sec-glow);
}
.xml-sec-label {
  display: block;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 1.5px;
  color: var(--accent);
  text-transform: uppercase;
  margin-bottom: 6px;
  opacity: .9;
}
hl {
  background: var(--hl-bg);
  color: var(--hl-fg);
  font-weight: 700;
  padding: 0 5px;
  border-radius: 4px;
  white-space: nowrap;
}
.xml-empty { color: var(--muted); font-style: italic; }
`;

// 内嵌网页内执行的小脚本：为自定义 XML 容器元素自动加可见分区标签，并通知父窗口自适应高度
const XML_EMBED_SCRIPT = `
(function(){
  var htmlTags = new Set(['html','head','body','style','script','meta','link','title','div','span','p','br','hr','b','i','strong','em','u','s','small','sub','sup','ul','ol','li','h1','h2','h3','h4','h5','h6','table','thead','tbody','tfoot','tr','td','th','a','img','code','pre','blockquote','section','article','header','footer','main','nav','aside']);
  document.querySelectorAll('body *').forEach(function(el){
    var tag = el.tagName.toLowerCase();
    if (htmlTags.has(tag)) return;
    if (tag === 'hl') return;
    var hasChildEl = el.querySelector('*') !== null;
    var multiline = (el.textContent || '').indexOf('\\n') >= 0;
    if (!hasChildEl && !multiline) return;
    var label = document.createElement('span');
    label.className = 'xml-sec-label';
    label.textContent = tag.toUpperCase();
    el.classList.add('xml-section');
    el.insertBefore(label, el.firstChild);
  });
  function post(){ var f = window.frameElement; if (f) { window.parent.postMessage({ __xmlResize: true, id: f.id, height: document.documentElement.scrollHeight }, '*'); } }
  post();
  window.addEventListener('load', post);
})();
`;

// 转义用于 HTML 属性的字符串（data-xml 等）
function escapeAttr(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// 识别嵌入标记：完整 HTML 文档 或 自定义 XML 块；引擎卡(game-xml)交给专用渲染路径
function detectEmbedMarkup(text) {
  if (!text || typeof text !== 'string') return null;
  const stripped = text
    .replace(/^```(?:html|xml)?\s*\n?/i, '')
    .replace(/\n?```\s*$/i, '')
    .trim();
  if (!stripped.startsWith('<')) return null;
  // 引擎卡标记（<content>/<now_plot>/<pic>/<update>…）由 renderGameMarkup 处理，不在此内嵌
  if (isGameMarkupText(stripped)) return null;
  // 结构化 ### 分段回复或 CoT 思考包裹（<customize_cot>/<think> 等）不当作内嵌 XML 文档渲染，
  // 交由正常分段解析流程处理，避免整段被塞进 iframe 且 ### 标记裸奔成纯文本
  if (/\n###\s+/m.test(stripped) || /^<(customize_cot|think|reasoning|thought|thinking)\b/i.test(stripped)) {
    return null;
  }
  if (/^<!DOCTYPE\s+html/i.test(stripped) || /^<html[\s>]/i.test(stripped)) {
    return { type: 'html', body: stripped };
  }
  const rootMatch = stripped.match(/^<([a-zA-Z][\w:-]*)\b[^>]*>/);
  if (rootMatch) {
    const root = rootMatch[1];
    const hasClose = new RegExp('</' + root + '\\s*>', 'i').test(stripped);
    const tagCount = (stripped.match(/<[a-zA-Z][\w:-]*\b/g) || []).length;
    if (hasClose || tagCount >= 2) {
      return { type: 'xml', body: stripped };
    }
  }
  return null;
}

/**
 * Unified AI-output classifier (Layer 1 of the SAM Plan-A pipeline).
 *
 * Replaces the scattered detectEmbedMarkup / isGameMarkupText checks with a single
 * decision used by renderAIBlock:
 *   - 'html'             → full HTML document → render in sandboxed iframe (unchanged)
 *   - 'xml'              → unknown custom XML root (a real widget) → sandboxed iframe (unchanged)
 *   - 'narrative-custom' → recognized narrative wrapper (e.g. <BattleScene>, <Scene>,
 *                          <small>, <b>, <i>…) → inline glass scene panel (NEW)
 *   - 'plain'            → normal prose / engine markup / CoT → normal gal-game flow
 *
 * Engine markup (<content>/<now_plot>/<json_patch>…) is intentionally routed to
 * 'plain' so the existing renderGameMarkup path still owns it. CoT / ### blocks are
 * also 'plain' so they never get embedded.
 */
const NARRATIVE_ROOT_TAGS = new Set([
  'battlescene', 'scene', 'narrative', 'narration', 'desc', 'description',
  'location', 'status', 'ooc', 'setting', 'atmosphere', 'action', 'innerthought',
  'thought', 'dialogue', 'monologue', 'flashback', 'interlude', 'aside'
]);

function classifyAIOutput(text) {
  if (!text || typeof text !== 'string') return { type: 'plain' };
  const stripped = text
    .replace(/^```(?:html|xml)?\s*\n?/i, '')
    .replace(/\n?```\s*$/i, '')
    .trim();
  if (!stripped.startsWith('<')) return { type: 'plain' };
  // Engine markup is owned by renderGameMarkup (handled later in the prose path).
  if (isGameMarkupText(stripped)) return { type: 'plain' };
  // CoT / structured ### blocks must flow through normal prose parsing.
  if (/\n###\s+/m.test(stripped) || /^<(customize_cot|think|reasoning|thought|thinking)\b/i.test(stripped)) {
    return { type: 'plain' };
  }
  if (/^<!DOCTYPE\s+html/i.test(stripped) || /^<html[\s>]/i.test(stripped)) {
    return { type: 'html', body: stripped };
  }
  const rootMatch = stripped.match(/^<([a-zA-Z][\w:-]*)\b[^>]*>/);
  if (rootMatch) {
    const root = rootMatch[1];
    const hasClose = new RegExp('</' + root + '\\s*>', 'i').test(stripped);
    const tagCount = (stripped.match(/<[a-zA-Z][\w:-]*\b/g) || []).length;
    if (hasClose || tagCount >= 2) {
      // Recognized narrative wrapper → inline render; otherwise iframe as before.
      if (NARRATIVE_ROOT_TAGS.has(root.toLowerCase())) {
        return { type: 'narrative-custom', body: stripped, root };
      }
      return { type: 'xml', body: stripped };
    }
  }
  return { type: 'plain' };
}

/**
 * Inline renderer for recognized narrative markup (Layer 2 of SAM Plan-A).
 *
 * Input is a recognized narrative wrapper (e.g. <BattleScene>…</BattleScene>) or any
 * prose interleaved with light semantic tags. Output is a self-contained glass
 * "scene panel" rendered inline in the chat — never an iframe.
 *
 * Security model (strict sanitizer):
 *   - The outer wrapper tag is stripped; inner content is split into blocks.
 *   - Prose blocks go through formatNarrationText (which escapes everything).
 *   - <small>…</small> → muted note; ```fences``` → <pre>; recognized headings /
 *     bullets → styled elements. Every restored/inserted value is escapeHtml'd, so
 *     no raw model tag can execute or leak as live markup.
 */
function renderCustomMarkup(raw, labelOverride) {
  if (!raw) return '';
  let body = String(raw).trim();

  // Strip the single outermost narrative wrapper tag (keep inner content).
  const wrap = body.match(/^<([a-zA-Z][\w:-]*)\b[^>]*>([\s\S]*?)<\/\1\s*>$/i);
  let rootLabel = '';
  if (wrap) { rootLabel = wrap[1]; body = wrap[2]; }

  // Protect <small> notes and fenced code blocks from prose formatting.
  const smalls = [];
  body = body.replace(/<small>([\s\S]*?)<\/small>/gi, (m, inner) => {
    smalls.push(inner.trim());
    return ' SMALL' + (smalls.length - 1) + ' ';
  });
  const codes = [];
  body = body.replace(/```([\s\S]*?)```/g, (m, code) => {
    codes.push(code.replace(/^\n/, '').replace(/\n$/, ''));
    return ' CODE' + (codes.length - 1) + ' ';
  });

  const lines = body.split('\n');
  const out = [];
  let paraBuf = [];
  const flushPara = () => {
    if (paraBuf.length) { out.push(formatNarrationText(paraBuf.join('\n'))); paraBuf = []; }
  };
  for (const line of lines) {
    const t = line.trim();
    if (t === '') { flushPara(); continue; }
    const smallM = t.match(/^ SMALL(\d+) $/);
    if (smallM) { flushPara(); out.push('<div class="muted-note">' + escapeHtml(smalls[+smallM[1]]) + '</div>'); continue; }
    const codeM = t.match(/^ CODE(\d+) $/);
    if (codeM) { flushPara(); out.push('<pre class="code-block"><code>' + escapeHtml(codes[+codeM[1]]) + '</code></pre>'); continue; }
    // Section headings: "I." "II." "12." "一、" (short title only, to limit false positives)
    const headM = t.match(/^(\*?\s*)?([IVXLC]+\.|[0-9]{1,2}\.|[一二三四五六七八九十]+[、.])\s+(.+)$/);
    if (headM && headM[3].trim().length <= 40) {
      flushPara();
      out.push('<h4 class="scene-heading">' + escapeHtml(headM[3].trim()) + '</h4>');
      continue;
    }
    // Bullet lines: "- text" / "* text"
    const bullM = t.match(/^[-*]\s+(.+)$/);
    if (bullM) { flushPara(); out.push('<div class="scene-bullet">• ' + escapeHtml(bullM[1].trim()) + '</div>'); continue; }
    paraBuf.push(line);
  }
  flushPara();

  let html = out.join('');

  // Global restore for inline (mid-paragraph) small/code placeholders.
  smalls.forEach((txt, i) => { html = html.split(' SMALL' + i + ' ').join('<span class="muted-note">' + escapeHtml(txt) + '</span>'); });
  codes.forEach((code, i) => { html = html.split(' CODE' + i + ' ').join('<pre class="code-block"><code>' + escapeHtml(code) + '</code></pre>'); });

  const label = labelOverride
    ? '<div class="scene-label">' + escapeHtml(labelOverride) + '</div>'
    : (rootLabel ? '<div class="scene-label">' + escapeHtml(rootLabel) + '</div>' : '');
  return '<div class="scene-panel">' + label + html + '</div>';
}

// ----- BEGIN: inline block splitting (mixed prose + custom XML blocks) -----
// Tags that are ordinary inline/HTML formatting — never treated as standalone blocks.
const INLINE_HTML_TAGS = new Set([
  'b','i','u','em','strong','small','span','br','p','a','sub','sup','code','pre',
  'li','ul','ol','h1','h2','h3','h4','h5','h6','table','tr','td','th','thead','tbody',
  'div','section','article','blockquote','hr','img','font','center','ruby','rt','rp',
  'details','summary','figure','figcaption','nav','header','footer','main','aside','mark','time'
]);
// Engine / variable blocks — owned elsewhere, never rendered as a panel.
const CORE_SKIP_BLOCKS = new Set([
  'jsonpatch','updatevariables','updatevariable','variable_update_call_format',
  'samcheckpoint','content','now_plot','pic','update','json_patch','status','ooc'
]);
const BLOCK_FRIENDLY_LABELS = {
  gacharesult: '抽卡结果', battoscene: '战斗场景', battle: '战斗', scene: '场景',
  narrative: '叙事', event: '事件', result: '结果', system: '系统', log: '记录',
  quest: '任务', inventory: '背包', shop: '商店', reward: '奖励', statusbar: '状态栏'
};
const BLOCK_BADGES = {
  gacharesult: '🎲 抽卡结果', battoscene: '⚔️ 战斗场景', battle: '⚔️ 战斗',
  quest: '📜 任务', inventory: '🎒 背包', shop: '🛒 商店', reward: '🎁 奖励',
  system: '⚙️ 系统', log: '📜 记录', event: '✨ 事件'
};

/**
 * Locate top-level balanced custom XML blocks embedded inside prose.
 * Returns ordered segments: { kind:'prose', text } | { kind:'block', body }.
 * Inline HTML formatting tags (<b>, <small>…) and engine/variable blocks are ignored,
 * and a block only counts if its opening tag starts a line (standalone, not mid-sentence).
 */
function splitInlineBlocks(text) {
  if (!text) return [{ kind: 'prose', text: text || '' }];
  const re = /<(\/?)([a-zA-Z][\w:-]*)\b[^>]*>/g;
  const stack = [];
  const tops = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const isClose = m[1] === '/';
    const name = m[2];
    if (isClose) {
      const top = stack.pop();
      if (top && top.name.toLowerCase() === name.toLowerCase() && stack.length === 0) {
        tops.push({ name: top.name, start: top.start, end: re.lastIndex });
      } else if (top) {
        stack.push(top);
      }
    } else {
      stack.push({ name, start: m.index });
    }
  }
  const blocks = [];
  for (const t of tops) {
    const body = text.slice(t.start, t.end);
    const lower = t.name.toLowerCase();
    if (INLINE_HTML_TAGS.has(lower)) continue;
    if (CORE_SKIP_BLOCKS.has(lower)) continue;
    if (isGameMarkupText(body)) continue;
    // Standalone: opening tag must begin a line (preceded by start or newline+ws).
    const before = t.start === 0 ? '' : text.slice(0, t.start);
    if (before && !/\n\s*$/.test(before)) continue;
    // Closing tag must end a line (followed by end or newline, or nothing after).
    const after = text.slice(t.end);
    if (after && !/^\s*\n/.test(after) && after.trim() !== '') continue;
    blocks.push({ name: t.name, start: t.start, end: t.end });
  }
  if (blocks.length === 0) return [{ kind: 'prose', text }];
  blocks.sort((a, b) => a.start - b.start);
  const segs = [];
  let cursor = 0;
  for (const b of blocks) {
    if (b.start > cursor) {
      const prose = text.slice(cursor, b.start);
      if (prose.trim()) segs.push({ kind: 'prose', text: prose });
    }
    segs.push({ kind: 'block', body: text.slice(b.start, b.end) });
    cursor = b.end;
  }
  if (cursor < text.length) {
    const prose = text.slice(cursor);
    if (prose.trim()) segs.push({ kind: 'prose', text: prose });
  }
  return segs.length ? segs : [{ kind: 'prose', text }];
}

/** Render a single custom block as an inline glass panel (never an iframe). */
function renderInlineBlock(body, isHidden) {
  const hiddenCls = isHidden ? ' is-hidden' : '';
  const mm = body.match(/^<([a-zA-Z][\w:-]*)\b/i);
  const tag = mm ? mm[1].toLowerCase() : '';
  const label = BLOCK_FRIENDLY_LABELS[tag] || (mm ? mm[1] : '模块');
  const badge = BLOCK_BADGES[tag] || '🧩 模块渲染';
  return `<div class="story-content scene-content${hiddenCls}">
    <div class="html-message-header">
      <span class="msg-time"></span>
      <span class="html-message-badge">${badge}</span>
    </div>
    ${renderCustomMarkup(body, label)}
  </div>`;
}

/** Render narrative prose, splitting out any inline custom blocks. */
function renderNarrativeWithBlocks(text) {
  const segs = splitInlineBlocks(text);
  if (segs.length === 1 && segs[0].kind === 'prose') {
    return [formatNarrationText(text)];
  }
  const out = [];
  segs.forEach(s => {
    if (s.kind === 'prose') {
      if (s.text.trim()) out.push(formatNarrationText(s.text));
    } else {
      out.push(renderInlineBlock(s.body, false));
    }
  });
  return out;
}

/** Render a prose chunk through the standard gal-game fallback pipeline. */
function renderPlainFallback(rawText) {
  const out = [];
  if (!rawText) return out;
  let displayText = rawText;
  const statusIdx = displayText.indexOf('=== 状态栏 ===');
  if (statusIdx >= 0) {
    const statusSection = displayText.slice(statusIdx + 10);
    displayText = displayText.slice(0, statusIdx).trim();
    parseStatusSection(statusSection);
  }
  if (displayText) {
    const lines = displayText.split('\n');
    let actionStart = lines.length;
    for (let i = lines.length - 1; i >= 0; i--) {
      const t = lines[i].trim();
      if (/^(?:\*\*)?-{1,2}\s*\d+[、．.]\s*.+/.test(t) && t.length > 5) {
        actionStart = i;
      } else break;
    }
    let actionLines = [];
    if (actionStart < lines.length) {
      actionLines = lines.slice(actionStart).map(l => {
        const am = l.trim().match(/^(?:\*\*)?-{1,2}\s*\d+[、．.]\s*(?:-{1,2}\s*)?(.+?)(?:\s*-{1,2}\*?\*?)?$/);
        return am ? am[1].trim() : l.trim().replace(/^(?:\*\*)?-{1,2}\s*\d+[、．.]\s*(?:-{1,2}\s*)?/, '').trim();
      });
      lines.splice(actionStart);
    }
    const cleanText = lines.join('\n').trim();
    if (cleanText) {
      if (isGameMarkupText(cleanText)) {
        out.push(renderGameMarkup(cleanText));
      } else {
        const mixedParts = splitStoryDialog(cleanText);
        mixedParts.forEach(part => {
          if (part.type === 'dialog') {
            out.push(renderDialogueBlock({ name: part.name, text: part.text, mood: '' }, 'left'));
          } else {
            out.push(formatNarrationText(part.text));
          }
        });
      }
    }
    if (actionLines.length > 0) out.push(renderActionButtons(actionLines));
  }
  return out;
}
// ----- END: inline block splitting -----

// 构建 iframe srcdoc 安全字符串（转义 & 与 "）
function buildEmbedDoc(body, type) {
  if (type === 'html') {
    return String(body).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  }
  const mode = document.body.getAttribute('theme-mode') || 'dark';
  const doc =
    '<!DOCTYPE html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<style>' + XML_EMBED_CSS + '</style></head>' +
    '<body class="theme-' + mode + '">' + body +
    '<script>' + XML_EMBED_SCRIPT + '<\/script></body></html>';
  return doc.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

// 父窗口监听内嵌网页的自适应高度请求
window.addEventListener('message', function (e) {
  const d = e.data;
  if (d && d.__xmlResize && d.id) {
    const f = document.getElementById(d.id);
    if (f) {
      const h = Math.min(d.height + 16, window.innerHeight * 0.8);
      f.style.height = Math.max(160, h) + 'px';
    }
  }
});

// 主题切换时，重新生成所有 XML 内嵌网页的 srcdoc 以同步明暗
function refreshEmbedThemes() {
  document.querySelectorAll('.xml-embed-iframe').forEach(function (iframe) {
    const raw = iframe.getAttribute('data-xml');
    if (!raw) return;
    const body = raw
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&');
    iframe.setAttribute('srcdoc', buildEmbedDoc(body, 'xml'));
  });
}

/**
 * 渲染 AI 回复块 —— Gal Game 风格 (旁白 + 头像对话框交替)
 */
function renderAIBlock(formatted, fallbackText, timeStr, isHidden) {
  const parts = [];

  // Replace {{user}} and {{char}} macros in fallback text
  fallbackText = replaceMacros(fallbackText);

  // Classify AI output (Layer 1): narrative markup → inline glass panel;
  // full HTML doc / unknown XML widget → sandboxed iframe; else normal prose flow.
  const cls = classifyAIOutput(fallbackText);
  if (cls.type === 'narrative-custom') {
    const hiddenCls = isHidden ? ' is-hidden' : '';
    return `<div class="story-content scene-content${hiddenCls}">
      <div class="html-message-header">
        <span class="msg-time">${escapeHtml(timeStr || '')}</span>
        <span class="html-message-badge">🎬 场景渲染</span>
      </div>
      ${renderCustomMarkup(cls.body)}
    </div>`;
  }
  if (cls.type === 'html' || cls.type === 'xml') {
    const embed = { type: cls.type, body: cls.body };
    const hiddenCls = isHidden ? ' is-hidden' : '';
    const srcdoc = buildEmbedDoc(embed.body, embed.type);
    const badge = embed.type === 'html' ? '📄 HTML 渲染' : '🧩 XML 渲染';
    const frameId = embed.type === 'xml' ? `xml-embed-${++xmlEmbedCounter}` : '';
    return `<div class="story-content html-message${hiddenCls}">
      <div class="html-message-header">
        <span class="msg-time">${escapeHtml(timeStr || '')}</span>
        <span class="html-message-badge">${badge}</span>
      </div>
      <iframe class="html-message-iframe xml-embed-iframe"${frameId ? ` id="${frameId}"` : ''} data-xml="${escapeAttr(embed.body)}" srcdoc="${srcdoc}"
        sandbox="allow-same-origin allow-scripts allow-popups allow-forms"
        loading="lazy"></iframe>
    </div>`;
  }

  // Handle double-nested format: { cleanText, formatted: { segments, mood, ... } }
  if (formatted && formatted.formatted && typeof formatted.formatted === 'object' && formatted.formatted.segments) {
    formatted = formatted.formatted;
  }

  // Also replace macros in segments text
  if (formatted && Array.isArray(formatted.segments)) {
    formatted.segments.forEach(seg => {
      if (seg.text) seg.text = replaceMacros(seg.text);
    });
  }

  // Strip <think>...</think> blocks from AI output (some models emit chain-of-thought)
  const stripThink = (text) => {
    if (!text) return text;
    return text
      .replace(/<customize_cot>[\s\S]*?<\/customize_cot>/gi, '')
      .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '')
      .replace(/<thought>[\s\S]*?<\/thought>/gi, '')
      .trim();
  };

  // 新格式：segments 数组
  if (formatted && formatted.segments && Array.isArray(formatted.segments) && formatted.segments.length > 0) {
    let dialogSide = 'left'; // 交替左右
    formatted.segments.forEach(seg => {
      seg.text = stripThink(seg.text || '');
      if (seg.type === 'story') {
        let storyText = seg.text || '';
        const statusIdx = storyText.indexOf('=== 状态栏 ===');
        if (statusIdx >= 0) {
          parseStatusSection(storyText.slice(statusIdx + 10));
          storyText = storyText.slice(0, statusIdx).trim();
        }
        if (storyText) {
          // 检测状态栏（避免混入选项）
          const subStatusIdx = storyText.indexOf('=== 状态栏 ===');
          if (subStatusIdx >= 0) {
            parseStatusSection(storyText.slice(subStatusIdx + 10));
            storyText = storyText.slice(0, subStatusIdx).trim();
          }
          // 从末尾向前找行动选项行（支持 --N、-- / - N. / - N、格式）
          const lines = storyText.split('\n');
          let actionStart = lines.length;
          for (let i = lines.length - 1; i >= 0; i--) {
            const t = lines[i].trim();
            if (/^(?:\*\*)?-{1,2}\s*\d+[、．.]\s*.+/.test(t) && t.length > 5) {
              actionStart = i;
            } else {
              break;
            }
          }
          let actionLines = [];
          if (actionStart < lines.length) {
            actionLines = lines.slice(actionStart).map(l => {
              const m = l.trim().match(/^(?:\*\*)?-{1,2}\s*\d+[、．.]\s*(?:-{1,2}\s*)?(.+?)(?:\s*-{1,2}\*?\*?)?$/);
              return m ? m[1].trim() : l.trim().replace(/^(?:\*\*)?-{1,2}\s*\d+[、．.]\s*(?:-{1,2}\s*)?/, '').trim();
            });
            lines.splice(actionStart);
          }
          const finalText = lines.join('\n').trim();
          if (finalText) parts.push(formatNarrationText(finalText));
          if (actionLines.length > 0) parts.push(renderActionButtons(actionLines));
        }
      } else if (seg.type === 'dialog') {
        parts.push(renderDialogueBlock(seg, dialogSide));
        dialogSide = dialogSide === 'left' ? 'right' : 'left';
      }
    });
    if (formatted.actions && Array.isArray(formatted.actions) && formatted.actions.length > 0) {
      parts.push(renderActionButtons(formatted.actions));
    }
  } else {
    // 无 segments → 回退渲染 fullText / text / fallbackText
    let rawText = (formatted && (formatted.fullText || formatted.text)) || fallbackText || '';
    rawText = stripThink(rawText);
    // Strip ### header sections (mood, portrait, actions, status, etc.) from rawText
    // Keep only story/dialogue content
    rawText = stripMetaSections(rawText);
    if (rawText) {
      // 混合内容：正文中可能内嵌自定义 XML 块（如 <GachaResult>），拆分后分别渲染
      const segs = splitInlineBlocks(rawText);
      if (segs.some(s => s.kind === 'block')) {
        segs.forEach(s => {
          if (s.kind === 'prose') {
            parts.push(...renderPlainFallback(s.text));
          } else {
            parts.push(renderInlineBlock(s.body, isHidden));
          }
        });
      } else {
        parts.push(...renderPlainFallback(rawText));
      }
    }
    // Also render formatted.actions if available (even without segments)
    if (formatted && formatted.actions && Array.isArray(formatted.actions) && formatted.actions.length > 0) {
      // Only add if not already rendered from text parsing
      const existingBtns = parts.some(p => p.includes('choice-option'));
      if (!existingBtns) parts.push(renderActionButtons(formatted.actions));
    }
  }

  // 时间戳
  const hiddenBadge = isHidden ? '<span class="hidden-badge">已隐藏</span>' : '';
  parts.push(`<div class="ai-time">${formatTime(timeStr)} ${hiddenBadge}</div>`);

  return parts.join('');
}

/**
 * 规范化行动选项数组。
 * 鲁棒处理各种畸形输出：
 *  - 单字符串（含换行或多个 "--N、" 标记）→ 拆成多个选项
 *  - 数组成员各自可能含换行/多个标记 → 逐条拆分
 *  - 自动剥离 "--1、" / "-1、" 等序号前缀，得到干净选项文案
 * 返回：字符串数组（每个选项一条），空输入返回 []
 */
function normalizeActions(input) {
  if (!input) return [];
  const arr = Array.isArray(input) ? input : [input];
  const markerRe = /-{1,2}\s*\d+[、．.]\s*/g;
  const out = [];
  for (let raw of arr) {
    if (raw == null) continue;
    const byNewline = String(raw).split(/\r?\n/);
    for (let piece of byNewline) {
      piece = piece.trim();
      if (!piece) continue;
      const matches = [...piece.matchAll(markerRe)];
      if (matches.length > 1) {
        // 一条里含多个选项标记 → 按标记切分
        for (let i = 0; i < matches.length; i++) {
          const start = matches[i].index + matches[i][0].length;
          const end = (i + 1 < matches.length) ? matches[i + 1].index : piece.length;
          const opt = piece.slice(start, end).trim().replace(/^-{1,2}\s*/, '').trim();
          if (opt) out.push(opt);
        }
      } else {
        // 单选项：剥离序号前缀
        const cleaned = piece.replace(markerRe, '').trim();
        if (cleaned) out.push(cleaned);
      }
    }
  }
  return out;
}

/**
 * 渲染行动选项按钮
 * 用 DOM API 构造节点，避开 "HTML 字符串拼接 + attribute 转义不全" 的陷阱：
 *   不再用 `data-action="${escapeHtml(action)}"` 这种字符串拼接，
 *   改用 dataset.action 直接赋值（属性值不经 HTML 解析，永远保留原文）。
 */
function renderActionButtons(actions) {
  actions = normalizeActions(actions);
  if (!actions || !Array.isArray(actions) || actions.length === 0) return '';

  // 兜底清洗：用空格替换选项文案中的 ASCII / 全角 双引号与单引号，
  // 避免与 HTML/JS/JSON 解析在拼接 / 序列化 / 存档回放等任一环节的冲突。
  // 替换（而非删除）保留原句语义节奏；连续引号合并成单个空格，
  // 再统一 trim + 合并剩余连续空格，避免出现两段文字因紧靠而粘连。
  // 这是最后一道防线，与 escapeHtml 收紧 + dataset 直接赋值无关，独立生效。
  actions = actions.map(a =>
    String(a)
      .replace(/[""'""'']+/g, ' ')
      .replace(/ {2,}/g, ' ')
      .trim()
  );

  const wrap = document.createElement('div');
  wrap.className = 'choice-menu';
  wrap.innerHTML =
    '<span class="menu-corner-tl"></span>' +
    '<span class="menu-sparkle ms1"></span>' +
    '<span class="menu-sparkle ms2"></span>' +
    '<div class="menu-title">你接下来要怎么做？</div>' +
    '<div class="choice-list"></div>';
  const list = wrap.querySelector('.choice-list');

  actions.forEach((action, i) => {
    const text = String(action);
    const btn = document.createElement('button');
    btn.className = 'choice-option';
    btn.dataset.action = text;                   // 关键：绕开 HTML attribute 解析
    btn.title = `选择选项${i + 1}`;

    const num = document.createElement('span');
    num.className = 'choice-number';
    num.textContent = String(i + 1);

    const lbl = document.createElement('span');
    lbl.className = 'choice-label';
    lbl.textContent = text;                       // textContent 不解析，永远安全

    const arrow = document.createElement('span');
    arrow.className = 'choice-arrow';

    btn.append(num, lbl, arrow);
    list.append(btn);
  });

  return wrap.outerHTML;
}

/**
 * Split text containing mixed narration and dialogue into parts.
 * Dialogue format: 姓名：『对白』 or 姓名：『对白』continued text
 * Returns array of { type: 'story'|'dialog', name?, text }
 */
function splitStoryDialog(text) {
  const parts = [];
  // Match: Name：『text』 or Name:『text』
  // Name must not contain sentence-ending punctuation (。！？) to avoid matching "叙事。姓名" as one name
  // Supports hyphenated names (NPC-742), Western names with · (汤姆·里德尔), and alphanumeric IDs
  const dialogRegex = /(?:^|\n|。|！|？)([^\n。！？:：]{1,30}?)[：:]\s*『([^』]+)』/g;
  let lastIndex = 0;
  let match;
  while ((match = dialogRegex.exec(text)) !== null) {
    // Text before this dialogue
    const before = text.slice(lastIndex, match.index + (match.index !== lastIndex ? 1 : 0)).trim();
    if (before) parts.push({ type: 'story', text: before });
    parts.push({ type: 'dialog', name: match[1].trim(), text: match[2].trim() });
    lastIndex = dialogRegex.lastIndex;
  }
  // Remaining text after last dialogue
  const after = text.slice(lastIndex).trim();
  if (after) parts.push({ type: 'story', text: after });
  // If no dialog found, return whole text as story
  if (parts.length === 0 && text.trim()) parts.push({ type: 'story', text: text.trim() });
  return parts;
}

/**
 * 渲染单条对话块（模板格式）
 */
function renderDialogueBlock(seg, side) {
  const name = seg.name || '角色';
  // 情绪标签( seg.mood )仅用于 TTS 语气生成，不在前端展示，避免过长描述影响视觉效果
  const imgPlaceholders = [];
  const safeDialogue = extractMarkdownImages(seg.text || '', imgPlaceholders);
  let text = escapeHtml(safeDialogue)
    .replace(/（([^）]+)）/g, '<em class="paren-italic">（$1）</em>')
    .replace(/\(([^)]+)\)/g, '<em class="paren-italic">($1)</em>');
  imgPlaceholders.forEach((img, idx) => {
    text = text.replace(`%%IMG_${idx}%%`, img);
  });
  const isUser = isUserSideName(name);

  // 头像：用户侧用上传头像（真实身份或游戏内扮演身份），角色从名册查找
  let avatarHtml = '';
  if (isUser) {
    const userAvatar = getUserAvatarForName(name);
    avatarHtml = userAvatar
      ? `<img src="${escapeHtml(userAvatar)}" alt="${escapeHtml(name)}">`
      : escapeHtml(name.charAt(0));
  } else {
    const result = lookupRosterEntry(name);
    const rosterEntry = result?.entry;
    const rosterName = result?.matchName || name;
    if (rosterEntry && rosterEntry.avatar && rosterEntry.avatar !== 'pending' && rosterEntry.avatar !== '' && rosterEntry.avatar !== '已有头像') {
      // 若名册头像已是绝对路径（如用户上传的 /uploads/...），直接使用，避免误拼 /api/saves 路径导致 404
      const avatarPath = rosterEntry.avatar.startsWith('/')
        ? rosterEntry.avatar
        : '/api/saves/' + getCurrentSaveId() + '/avatar/' + encodeURIComponent(rosterName);
      avatarHtml = `<img src="${escapeHtml(avatarPath)}" alt="${escapeHtml(name)}">`;
    } else {
      avatarHtml = escapeHtml(name.charAt(0));
    }
  }

  const colorStyle = buildGalColorStyle(name);
  const isLeft = side !== 'right';
  const sideClass = isLeft ? 'dialog-wrapper-left' : 'dialog-wrapper-right';

  return `
    <div class="dialog-wrapper ${sideClass}" ${colorStyle}>
      <div class="dialogue-avatar">${avatarHtml}</div>
      <div class="dialogue-bubble">
        <span class="corner-decor-tl"></span>
        <span class="edge-sparkle s1"></span>
        <span class="edge-sparkle s2"></span>
        <span class="edge-sparkle s3"></span>
        <div class="dialog-content">
          <div class="dialogue-name-row">
            <span class="dialogue-name">${escapeHtml(displaySpeakerName(name))}</span>
          </div>
          <span class="dialogue-divider"></span>
          <p class="dialogue-text">${text}</p>
        </div>
      </div>
    </div>`;
}

/**
 * 根据角色颜色生成 GAL 调色板并返回 inline style
 */
function buildGalColorStyle(name) {
  const color = getCharColor(name);
  if (!color) return '';
  const isLight = document.body.getAttribute('theme-mode') === 'light';
  const base = color[isLight ? 'light' : 'dark'];

  // 从 rgba 中提取 r,g,b
  const match = base.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!match) return `style="background:${base}"`;
  const r = parseInt(match[1]), g = parseInt(match[2]), b = parseInt(match[3]);

  const lighten = (v, amt) => Math.min(255, v + amt);
  const darken = (v, amt) => Math.max(0, v - amt);
  const c = (rr, gg, bb, a) => `rgba(${rr},${gg},${bb},${a})`;

  if (isLight) {
    // 亮色主题：浅底 + 深色边框 + 深色文字
    const vars = {
      '--gal-blue-50': c(lighten(r, 100), lighten(g, 100), lighten(b, 100), 0.98),
      '--gal-blue-100': c(lighten(r, 80), lighten(g, 80), lighten(b, 80), 0.97),
      '--gal-blue-200': c(lighten(r, 55), lighten(g, 55), lighten(b, 55), 0.93),
      '--gal-blue-300': c(lighten(r, 30), lighten(g, 30), lighten(b, 30), 0.88),
      '--gal-blue-400': c(r, g, b, 0.81),
      '--gal-blue-500': c(darken(r, 20), darken(g, 20), darken(b, 20), 0.74),
      '--gal-blue-600': c(darken(r, 45), darken(g, 45), darken(b, 45), 0.66),
      '--gal-blue-700': c(darken(r, 70), darken(g, 70), darken(b, 70), 0.55),
      '--gal-line': c(darken(r, 20), darken(g, 20), darken(b, 20), 0.45),
      '--gal-dot': c(darken(r, 40), darken(g, 40), darken(b, 40), 0.5),
      // 亮色下边框用深色（原浅蓝 → 深蓝）
      '--gal-border-out': c(darken(r, 60), darken(g, 60), darken(b, 60), 0.62),
      '--gal-av-b1': c(lighten(r, 40), lighten(g, 40), lighten(b, 40), 0.85),
      '--gal-av-b2': c(lighten(r, 100), lighten(g, 100), lighten(b, 100), 0.98),
      '--gal-av-b3': c(darken(r, 20), darken(g, 20), darken(b, 20), 0.62),
      '--gal-body-grad': `linear-gradient(175deg, ${c(lighten(r, 90), lighten(g, 90), lighten(b, 90), 0.98)} 0%, ${c(lighten(r, 70), lighten(g, 70), lighten(b, 70), 0.96)} 15%, ${c(lighten(r, 110), lighten(g, 110), lighten(b, 110), 0.99)} 40%, ${c(lighten(r, 60), lighten(g, 60), lighten(b, 60), 0.95)} 85%, ${c(lighten(r, 40), lighten(g, 40), lighten(b, 40), 0.93)} 100%)`,
      '--gal-text-name': color.isUser ? '#3D2010' : c(darken(r, 90), darken(g, 90), darken(b, 90), 0.92),
      '--gal-text-dia': color.isUser ? '#3D2010' : c(darken(r, 80), darken(g, 80), darken(b, 80), 0.90),
      '--gal-shadow': '0 8px 32px rgba(60,100,140,0.18)',
      '--gal-glow': '0 0 40px rgba(130,180,210,0.12)',
    };
    return `style="${Object.entries(vars).map(([k, v]) => `${k}:${v}`).join(';')}"`;
  } else {
    // 暗色主题：黑灰底 + 浅色边框 + 亮色文字
    const vars = {
      '--gal-blue-50': c(darken(r, 80), darken(g, 80), darken(b, 80), 0.4),
      '--gal-blue-100': c(darken(r, 60), darken(g, 60), darken(b, 60), 0.35),
      '--gal-blue-200': c(darken(r, 40), darken(g, 40), darken(b, 40), 0.30),
      '--gal-blue-300': c(darken(r, 20), darken(g, 20), darken(b, 20), 0.28),
      '--gal-blue-400': c(lighten(r, 15), lighten(g, 15), lighten(b, 15), 0.55),
      '--gal-blue-500': c(lighten(r, 35), lighten(g, 35), lighten(b, 35), 0.65),
      '--gal-blue-600': c(lighten(r, 55), lighten(g, 55), lighten(b, 55), 0.75),
      '--gal-blue-700': c(lighten(r, 80), lighten(g, 80), lighten(b, 80), 0.85),
      '--gal-line': c(lighten(r, 30), lighten(g, 30), lighten(b, 30), 0.35),
      '--gal-dot': c(lighten(r, 50), lighten(g, 50), lighten(b, 50), 0.4),
      // 暗色下边框用浅色（可见于深色背景）
      '--gal-border-out': c(lighten(r, 60), lighten(g, 60), lighten(b, 60), 0.45),
      '--gal-av-b1': c(lighten(r, 25), lighten(g, 25), lighten(b, 25), 0.35),
      '--gal-av-b2': c(lighten(r, 45), lighten(g, 45), lighten(b, 45), 0.20),
      '--gal-av-b3': c(lighten(r, 60), lighten(g, 60), lighten(b, 60), 0.30),
      // 暗色气泡背景：黑灰色，带角色颜色微调
      '--gal-body-grad': `linear-gradient(175deg, ${c(darken(r, 90), darken(g, 90), darken(b, 90), 0.55)} 0%, ${c(darken(r, 70), darken(g, 70), darken(b, 70), 0.50)} 15%, ${c(darken(r, 50), darken(g, 50), darken(b, 50), 0.48)} 40%, ${c(darken(r, 75), darken(g, 75), darken(b, 75), 0.52)} 85%, ${c(darken(r, 85), darken(g, 85), darken(b, 85), 0.55)} 100%)`,
      '--gal-text-name': c(lighten(r, 140), lighten(g, 140), lighten(b, 140), 0.92),
      '--gal-text-dia': c(lighten(r, 130), lighten(g, 130), lighten(b, 130), 0.88),
      '--gal-shadow': '0 8px 32px rgba(0,0,0,0.35)',
      '--gal-glow': '0 0 40px rgba(100,140,180,0.08)',
    };
    return `style="${Object.entries(vars).map(([k, v]) => `${k}:${v}`).join(';')}"`;
  }
}


/**
 * 西式姓名模糊查找：从角色名册中匹配说话者
 * 支持精确匹配、子串匹配、以及 · 分隔的部分匹配
 * 例如：说话者"汤姆" → 匹配名册中的"汤姆·里德尔"
 *       说话者"里德尔" → 匹配名册中的"汤姆·里德尔"
 *       说话者"汤姆·里德尔" → 精确匹配
 * @param {string} speakerName 说话者姓名
 * @returns {{ entry: object, matchName: string }|null} 匹配的名册条目和匹配到的完整姓名
 */
/**
 * 判断某个对话名是否属于「用户侧」（主角真实身份 或 游戏内扮演身份）
 * —— 修复主角头像不定时丢失：模型用扮演名/变体名写主角台词时仍能稳定识别。
 *
 * 【只允许在「说话人标签」这个结构位上调用，绝不要拿去扫正文】—— 正文里的「我 / 你」
 * 是普通代词，全量替换必然误判。AI 有时用 你：『…』 或 我：『…』 让用户说话
 * （取决于卡/预设的人称视角），这两种都算用户。
 */
function isUserSideName(name) {
  const n = String(name == null ? '' : name).trim();
  if (!n) return false;
  /* 自称代词：先判掉，顺带避免 userProfile 尚未加载时漏判 */
  if (n === '我' || n === '你' || n === '自己' || n === '俺' || n === '咱') return true;
  const up = AppState.userProfile;
  if (!up) return false;
  const userName = up.name || '我';
  const personaName = up.persona_name || '';
  /* 注意别写成 `n === userName || (personaName && n === personaName)`：
     那样 personaName 为空时整式会返回 ''（&& 返回操作数），虽仍是假值，
     但会让 === false 之类的严格判断失效。这里显式转布尔。 */
  return n === userName || (!!personaName && n === personaName);
}

/**
 * 说话人标签 → 展示用名字：用户侧的「我 / 你 / 自己」统一显示成用户名
 * （或游戏内扮演名），避免名牌上出现「你：『…』」这种视角错位。
 * 只处理标签，不碰正文。
 */
function displaySpeakerName(name) {
  const n = String(name == null ? '' : name).trim();
  if (!isUserSideName(n)) return n;
  const up = AppState.userProfile || {};
  const persona = (up.persona_name || '').trim();
  if (persona && n === persona) return persona;
  return (up.name || '我').trim() || '我';
}
/**
 * 返回用户侧应显示的头像路径：扮演名且有专属头像 → 扮演头像；否则用真实身份头像。
 */
function getUserAvatarForName(name) {
  const up = AppState.userProfile;
  if (!up) return '';
  const personaName = up.persona_name || '';
  if (personaName && name === personaName && up.persona_avatar) return up.persona_avatar;
  return up.avatar || '';
}

function lookupRosterEntry(speakerName) {
  if (!speakerName || !AppState.characterRoster) return null;
  // 1. 精确匹配
  if (AppState.characterRoster[speakerName]) {
    return { entry: AppState.characterRoster[speakerName], matchName: speakerName };
  }
  // 2. 遍历名册，模糊匹配
  const rosterKeys = Object.keys(AppState.characterRoster);
  for (const key of rosterKeys) {
    // 说话者是名册中名字的子串（如"汤姆" ⊂ "汤姆·里德尔"）
    if (key.includes(speakerName) || speakerName.includes(key)) {
      return { entry: AppState.characterRoster[key], matchName: key };
    }
    // 3. 按 · 或 - 拆分后分别匹配（西式姓名 / 游戏编号名）
    if (key.includes('·') || speakerName.includes('·') || key.includes('-') || speakerName.includes('-')) {
      const separators = /[·\-]/;
      const keyParts = key.split(separators).map(p => p.trim());
      const spkParts = speakerName.split(separators).map(p => p.trim());
      for (const kp of keyParts) {
        for (const sp of spkParts) {
          if (kp && sp && (kp === sp || kp.includes(sp) || sp.includes(kp))) {
            return { entry: AppState.characterRoster[key], matchName: key };
          }
        }
      }
    }
  }
  return null;
}

function formatGalGameText(text) {
  if (!text) return '';

  // 安全清理：如果 AI 把 \\n 写成了字面字符串 \n（两个字符），替换为真正换行
  // JSON 解析后真正的换行已经是 \n 字符，这里处理的是漏网的字面 \n
  text = text.replace(/\\n/g, '\n');

  // 默认角色信息（当对话未标注说话者时使用）
  const defaultName = AppState.currentCharacter ? AppState.currentCharacter.name : '角色';
  const defaultAvatar = AppState.currentCharacter ? AppState.currentCharacter.avatar : null;

  /**
   * 根据说话者姓名生成头像 HTML
   */
  function speakerAvatar(name) {
    // 用户侧（真实身份或游戏内扮演身份）优先用用户头像
    if (isUserSideName(name)) {
      const av = getUserAvatarForName(name);
      if (av) return `<img src="${escapeHtml(av)}" alt="${escapeHtml(name)}">`;
      return escapeHtml(name.charAt(0));
    }
    // 从角色名册查找头像（支持西式姓名模糊匹配）
    const result = lookupRosterEntry(name);
    const rosterEntry = result?.entry;
    const rosterName = result?.matchName || name;
    if (rosterEntry && rosterEntry.avatar && rosterEntry.avatar !== 'pending' && rosterEntry.avatar !== '') {
      const avatarPath = rosterEntry.avatar.startsWith('/') ? rosterEntry.avatar : '/api/saves/' + getCurrentSaveId() + '/avatar/' + encodeURIComponent(rosterName);
      return `<img src="${escapeHtml(avatarPath)}" alt="${escapeHtml(name)}">`;
    }
    const initial = name.charAt(0);
    if (name === defaultName && defaultAvatar) {
      return `<img src="${escapeHtml(defaultAvatar)}" alt="${escapeHtml(name)}">`;
    }
    return escapeHtml(initial);
  }

  // 拆分：旁白和对话交替
  // 匹配：「角色名：『内容』」或「『内容』」（省略姓名沿用上一个说话者）
  // 说话者支持CJK、字母、数字、·和-（如 NPC-742、汤姆·里德尔）
  const segments = [];
  const regex = /(?:([\w\u4e00-\u9fff\u3400-\u4dbf\s·\-]+?)：\s*)?『([^』]+)』/g;
  let lastIndex = 0;
  let match;
  let lastSpeaker = null;  // 记住上一个说话者，省略姓名时沿用

  while ((match = regex.exec(text)) !== null) {
    // 提取说话者姓名（去掉首尾空白和换行）
    const speaker = match[1] ? match[1].replace(/[\s\n]+/g, '').trim() : null;
    const effectiveSpeaker = speaker || lastSpeaker || defaultName;
    lastSpeaker = effectiveSpeaker;

    const dialogueText = match[2];

    // 前一段旁白
    const beforeDialogue = text.slice(lastIndex, match.index);
    if (beforeDialogue.trim()) {
      segments.push({
        type: 'narration',
        text: formatNarrationText(beforeDialogue),
      });
    }

    // 对话块（含说话者）
    segments.push({
      type: 'dialogue',
      speaker: effectiveSpeaker,
      text: escapeHtml(dialogueText)
        .replace(/（([^）]+)）/g, '<em class="paren-italic">（$1）</em>')
        .replace(/\(([^)]+)\)/g, '<em class="paren-italic">($1)</em>'),
    });

    lastIndex = match.index + match[0].length;
  }

  // 剩余旁白
  const afterText = text.slice(lastIndex).trim();
  if (afterText) {
    segments.push({
      type: 'narration',
      text: formatNarrationText(afterText),
    });
  }

  // 如果没有任何对话，全部是旁白
  if (segments.length === 0 && text.trim()) {
    segments.push({
      type: 'narration',
      text: formatNarrationText(text),
    });
  }

  // 渲染（左右交替）
  let sideFlip = false;
  return segments.map(seg => {
    if (seg.type === 'dialogue') {
      sideFlip = !sideFlip;
      const sideClass = sideFlip ? 'dialogue-block-left' : 'dialogue-block-right';
      const avatarHtml = speakerAvatar(seg.speaker);
      const nameHtml = escapeHtml(displaySpeakerName(seg.speaker));
      const textHtml = seg.text;

      if (sideFlip) {
        // 左位：头像在左
        return `
          <div class="dialogue-block ${sideClass}">
            <div class="dialogue-avatar">${avatarHtml}</div>
            <div class="dialogue-bubble">
              <div class="dialogue-header"><span class="dialogue-name">${nameHtml}</span></div>
              <div class="dialogue-divider"></div>
              <div class="dialogue-body">${textHtml}</div>
            </div>
          </div>`;
      } else {
        // 右位：头像在右
        return `
          <div class="dialogue-block ${sideClass}">
            <div class="dialogue-bubble">
              <div class="dialogue-header"><span class="dialogue-name">${nameHtml}</span></div>
              <div class="dialogue-divider"></div>
              <div class="dialogue-body">${textHtml}</div>
            </div>
            <div class="dialogue-avatar">${avatarHtml}</div>
          </div>`;
      }
    } else {
      return `<div class="narration-text">${seg.text}</div>`;
    }
  }).join('');
}

/**
 * 格式化旁白文本：处理换行和 *斜体动作*
 */
/**
 * Build a safe <img> tag for a markdown image URL.
 * Only allows http(s):, data:image/, blob:, and / ./. relative paths.
 * Rejects dangerous schemes (javascript:, data:text/html, etc.).
 * The URL is HTML-escaped before insertion to neutralize quotes.
 */
function sanitizeImageUrl(url) {
  if (typeof url !== 'string') return '';
  const t = url.trim();
  if (/^(https?:\/\/|blob:)/i.test(t)) return escapeHtml(t);
  if (/^data:image\//i.test(t)) return escapeHtml(t);
  if (/^[\/.]/.test(t)) return escapeHtml(t); // absolute (/x) or relative (./x, ../x)
  return '';
}

/**
 * Bare (non-markdown) image links found inside character cards, e.g.
 *   https://example.com/portrait.png
 * Supported extensions: png / jpg / jpeg / bmp / gif / webp / avif.
 * An optional query string (`?w=640`) is kept as part of the URL.
 * The character class excludes whitespace, quotes, brackets and CJK punctuation,
 * so trailing marks like "。" or "）" never leak into the captured URL.
 */
const BARE_IMAGE_URL_RE =
  /(https?:\/\/[^\s<>"'`()[\]{}，。！？；：、）】》」』]+\.(?:png|jpe?g|bmp|gif|webp|avif)(?:\?[^\s<>"'`()[\]{}，。！？；：、）】》」』]*)?)/gi;

/**
 * Build markup for one inline image: the <img> plus a visible chip fallback that
 * appears when the remote host is unreachable or blocks hotlinking.
 */
function buildInlineImageHtml(safeUrl, rawUrl) {
  return `<span class="msg-inline-image-wrap">` +
    `<img class="msg-inline-image" src="${safeUrl}" alt="" loading="lazy" ` +
    `onerror="this.style.display='none';this.nextElementSibling.style.display='inline-flex';">` +
    `<span class="msg-image-fallback" style="display:none" title="图片加载失败：${escapeHtml(rawUrl)}">` +
    `<span class="pic-icon">🖼️</span><span class="pic-label">${escapeHtml(rawUrl)}</span></span>` +
    `</span>`;
}

/**
 * Replace markdown image syntax ![alt](url) in `text` with %%IMG_N%% placeholders,
 * pushing safe <img> HTML into `placeholders`. Caller must restore placeholders
 * AFTER all other HTML escaping/transforms so the injected markup is not broken.
 *
 * Also picks up bare image links (see BARE_IMAGE_URL_RE) so character cards that
 * embed raw URLs such as https://host/a.png still render the picture.
 * Returns the (placeholder-substituted) text.
 */
function extractMarkdownImages(text, placeholders) {
  if (typeof text !== 'string') return text;
  // Pass 1: markdown syntax ![alt](url)
  let rest = text.replace(/!\[[^\]]*\]\([ \t]*([^)\s]+)[ \t]*(?:\s+"[^"]*")?\)/g, (m, url) => {
    const safe = sanitizeImageUrl(url);
    if (!safe) return m; // leave unsafe as raw text (caller escapes it)
    const idx = placeholders.length;
    placeholders.push(buildInlineImageHtml(safe, url));
    return `%%IMG_${idx}%%`;
  });
  // Pass 2: bare image links (already-consumed markdown URLs are gone by now)
  return extractBareImageUrls(rest, placeholders);
}

/**
 * Replace bare image URLs (http(s) links ending with an image extension) with
 * %%IMG_N%% placeholders, pushing safe <img> HTML into `placeholders`.
 */
function extractBareImageUrls(text, placeholders) {
  if (typeof text !== 'string') return text;
  return text.replace(BARE_IMAGE_URL_RE, (match, url, offset, full) => {
    // Skip URLs already owned by other markup: href="…" / src="…" / (…) / <…>
    const prev = offset > 0 ? full[offset - 1] : '';
    if (prev && /[("'<=[]/.test(prev)) return match;
    const safe = sanitizeImageUrl(url);
    if (!safe) return match;
    const idx = placeholders.length;
    placeholders.push(buildInlineImageHtml(safe, url));
    return `%%IMG_${idx}%%`;
  });
}

/**
 * Render inline markdown images inside user-typed text.
 * Escapes HTML, converts \n to <br>, then restores safe <img> tags.
 */
function renderInlineImages(content) {
  const placeholders = [];
  const safe = extractMarkdownImages(content || '', placeholders);
  let html = escapeHtml(safe).replace(/\n/g, '<br>');
  placeholders.forEach((img, idx) => {
    html = html.replace(`%%IMG_${idx}%%`, img);
  });
  return html;
}

function formatNarrationText(text) {
  // Step 0: 分离 <!-- --> 注释块，替换为隐藏的 nowork 标签
  const commentBlocks = [];
  let processed = text.replace(/<!--([\s\S]*?)-->/g, (match, inner) => {
    const idx = commentBlocks.length;
    commentBlocks.push(`<p class="nowork">${escapeHtml(inner.trim())}</p>`);
    return `%%NOWORK_${idx}%%`;
  });

  // Step 1: markdown 表格
  const tablePlaceholders = [];
  processed = renderMarkdownTables(processed, tablePlaceholders);

  // Step 1.5: markdown 图片 ![alt](url) → 占位符（避免被转义/斜体正则破坏，集中还原）
  const imgPlaceholders = [];
  processed = extractMarkdownImages(processed, imgPlaceholders);

  // Step 2: 转义
  let html = escapeHtml(processed).replace(/\\n/g, '<br>');
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  // Step 2.5: 括号内内容用斜体（全角/半角括号）
  html = html.replace(/（([^）]+)）/g, '<em class="paren-italic">（$1）</em>');
  html = html.replace(/\(([^)]+)\)/g, '<em class="paren-italic">($1)</em>');
  html = html.replace(/\n\n+/g, '</p><p class="narration-text">');
  html = html.replace(/\n/g, '<br>');
  if (!html.startsWith('<p')) html = '<p class="narration-text">' + html + '</p>';

  // Step 3: 恢复 nowork
  commentBlocks.forEach((block, idx) => {
    html = html.replace(`%%NOWORK_${idx}%%`, block);
  });
  // Step 4: 恢复表格
  tablePlaceholders.forEach((th, idx) => {
    html = html.replace(`%%TABLE_${idx}%%`, th);
  });
  // Step 5: 恢复 markdown 图片
  imgPlaceholders.forEach((img, idx) => {
    html = html.replace(`%%IMG_${idx}%%`, img);
  });

  return html;
}

/**
 * 判断文本是否包含游戏自定义标记（engine card 标记）。
 * 用于无 segments 回退渲染时，决定走 renderGameMarkup 还是普通 narration 渲染。
 */
function isGameMarkupText(text) {
  if (!text) return false;
  return /<content>|<now_plot>|<pic>|<\/?json_patch>|<update>|<UpdateVariables>|\{[^}\n]{1,30}\}「/.test(text);
}

/**
 * 渲染含有自定义游戏标记（Tavern Helper 风格）的文本。
 * 标记：<content>/<now_plot>/<pic>PATH</pic>/<update>/<update_analysis>/<json_patch> + {name}「...」
 * 白名单消毒：仅保留有限 HTML；`<pic>` 解析为立绘（默认从该角色卡的存档目录加载，缺失则占位 chip）。
 */
function renderGameMarkup(raw) {
  if (!raw) return '';
  // 防御：纯叙事文本（不含任何引擎标记）直接走通用叙事渲染，绝不被当 XML 解析
  if (!isGameMarkupText(raw)) return formatNarrationText(raw);

  // 1) 抽取引擎元信息块 <update>...</update>（含 update_analysis / json_patch）与
  //    <UpdateVariables>...</UpdateVariables>（Tavern Helper 变量更新），最后单独渲染
  const updateBlocks = [];
  const uvBlocks = [];
  let body = raw.replace(/<update>([\s\S]*?)<\/update>/g, (m) => {
    updateBlocks.push(m);
    return '';
  });
  body = body.replace(/<UpdateVariables>([\s\S]*?)<\/UpdateVariables>/g, (m) => {
    uvBlocks.push(m);
    return '';
  });

  // 2) 取 <content> 包裹内的正文（兼容无 <content> 直接 <now_plot> 的情况）
  const contentMatch = body.match(/<content>([\s\S]*?)<\/content>/);
  const narrative = contentMatch ? contentMatch[1] : body;

  // 3) 渲染正文：在叙事流中穿插内联 <pic> 与 {name}「...」对白
  let html = renderGameNarrative(narrative);

  // 4) 渲染引擎元信息（状态更新 / 世界状态补丁 / UpdateVariables），默认折叠
  if (updateBlocks.length || uvBlocks.length) {
    html += updateBlocks.map(renderGameUpdate).join('');
    html += uvBlocks.map(renderGameUpdateVariables).join('');
  }

  return html;
}

/** 渲染 <UpdateVariables> 块：折叠展示原始 SQL 方言语句，便于核对变量变更。 */
function renderGameUpdateVariables(block) {
  const inner = block.replace(/^<UpdateVariables>/, '').replace(/<\/UpdateVariables>$/, '');
  return '<details class="game-updatevars"><summary>🔧 变量更新 (UpdateVariables)</summary>' +
    '<pre class="game-patch-pre">' + escapeHtml(inner.trim()) + '</pre></details>';
}

function renderGameNarrative(text) {
  if (!text) return '';
  // 收集 <pic> 与 {name}「...」两种 token（按出现顺序）
  const tokens = [];
  let m;
  const picRe = /<pic>([\s\S]*?)<\/pic>/g;
  while ((m = picRe.exec(text)) !== null) {
    tokens.push({ type: 'pic', start: m.index, end: m.index + m[0].length, val: m[1].trim() });
  }
  const dlgRe = /\{(\S+?)\}「([\s\S]*?)」/g;
  while ((m = dlgRe.exec(text)) !== null) {
    tokens.push({ type: 'dlg', start: m.index, end: m.index + m[0].length, name: m[1].trim(), val: m[2].trim() });
  }
  tokens.sort((a, b) => a.start - b.start);

  let out = '';
  let last = 0;
  for (const t of tokens) {
    if (t.start > last) out += renderGameNarrationText(text.slice(last, t.start));
    if (t.type === 'pic') out += renderGamePic(t.val);
    else out += renderGameDialogue(t.name, t.val);
    last = t.end;
  }
  if (last < text.length) out += renderGameNarrationText(text.slice(last));
  return out;
}

function renderGameNarrationText(text) {
  if (!text || !text.trim()) return '';
  // 复用通用 narration 渲染（转义 + 段落 + 斜体 + markdown 图片）
  return formatNarrationText(text);
}

function renderGameDialogue(name, text) {
  let html = escapeHtml(text)
    .replace(/（([^）]+)）/g, '<em class="paren-italic">（$1）</em>')
    .replace(/\n/g, '<br>');
  /* 说话人标签同样做「我/你 → 用户名」归一（只动标签，正文 html 不动） */
  return `<div class="speaker-line"><span class="speaker-name">${escapeHtml(displaySpeakerName(name))}</span>` +
    `<span class="speaker-dialogue">「${html}」</span></div>`;
}

function renderGamePic(picPath) {
  const char = AppState.currentCharacter;
  if (!char) {
    return `<span class="game-pic-placeholder" title="立绘资源未配置：${escapeHtml(picPath)}">` +
      `<span class="pic-icon">🖼️</span><span class="pic-label">${escapeHtml(picPath)}</span></span>`;
  }
  /* 立绘默认存放于该角色卡的存档目录（saves/gameNNNN/ 及其 sub 存档），无需手动配置路径 */
  const id = encodeURIComponent(char.id);
  const segs = picPath.split('/').map(s => encodeURIComponent(s)).join('/');
  const url = `/api/characters/${id}/asset/${segs}`;
  return `<span class="game-pic-wrap">` +
    `<img class="game-pic" src="${url}" alt="${escapeHtml(picPath)}" loading="lazy" ` +
    `onerror="this.style.display='none';this.nextElementSibling.style.display='inline-flex';">` +
    `<span class="game-pic-placeholder" style="display:none" title="立绘未找到：${escapeHtml(picPath)}">` +
    `<span class="pic-icon">🖼️</span><span class="pic-label">${escapeHtml(picPath)}</span></span>` +
    `</span>`;
}

function renderGameUpdate(block) {
  const analysis = block.match(/<update_analysis>([\s\S]*?)<\/update_analysis>/);
  const patch = block.match(/<json_patch>([\s\S]*?)<\/json_patch>/);
  let html = '<div class="game-update">';
  if (analysis) {
    html += '<details class="game-update-analysis"><summary>📝 剧情 / 状态更新</summary>' +
      formatNarrationText(analysis[1].trim()) + '</details>';
  }
  if (patch) {
    html += '<details class="game-jsonpatch"><summary>⚙️ 世界状态 (json_patch)</summary>' +
      '<pre class="game-patch-pre">' + escapeHtml(patch[1].trim()) + '</pre></details>';
  }
  html += '</div>';
  return html;
}

// ===================== MVU 世界状态引擎 (Tier 3 闭环) =====================
// 解析 engine 卡 AI 输出的 <json_patch> (RFC 6902) 并维护一个世界状态模型树，
// 提供可读写的状态检视器 + 操作按钮（重新读取初始变量/重新处理变量/清除楼层变量）。

const WS_FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);
function wsSplitPath(path) {
  if (!path || path[0] !== '/') throw new Error('Invalid path: ' + path);
  const tokens = path.slice(1).split('/').map(t => t.replace(/~1/g, '/').replace(/~0/g, '~'));
  if (tokens.some(t => WS_FORBIDDEN.has(t))) throw new Error('Forbidden path: ' + path);
  return tokens;
}
function wsClone(v) { return (v && typeof v === 'object') ? JSON.parse(JSON.stringify(v)) : v; }
function wsResolve(obj, tokens) {
  let cur = obj;
  for (const t of tokens) { if (cur == null) return undefined; cur = cur[t]; }
  return cur;
}
function wsEnsureParent(obj, parentTokens) {
  let cur = obj;
  for (const t of parentTokens) {
    if (cur[t] == null || typeof cur[t] !== 'object') cur[t] = /^\d+$/.test(t) ? [] : {};
    cur = cur[t];
  }
  return cur;
}
function wsApplySingle(model, op) {
  const tokens = wsSplitPath(op.path);
  const parentTokens = tokens.slice(0, -1);
  const key = tokens[tokens.length - 1];
  if (WS_FORBIDDEN.has(key)) throw new Error('Forbidden key: ' + key);
  switch (op.op) {
    case 'add': {
      const p = wsEnsureParent(model, parentTokens);
      if (Array.isArray(p)) {
        const idx = key === '-' ? p.length : parseInt(key, 10);
        p.splice(idx, 0, wsClone(op.value));
      } else p[key] = wsClone(op.value);
      break;
    }
    case 'replace': {
      const p = wsEnsureParent(model, parentTokens);
      if (Array.isArray(p)) { const i = parseInt(key, 10); p[i] = wsClone(op.value); }
      else p[key] = wsClone(op.value);
      break;
    }
    case 'remove': {
      const p = wsResolve(model, parentTokens);
      if (p == null) return;
      if (Array.isArray(p)) p.splice(parseInt(key, 10), 1); else delete p[key];
      break;
    }
    case 'move': {
      const v = wsApplySingle(model, { op: 'get', path: op.from });
      wsApplySingle(model, { op: 'remove', path: op.from });
      wsApplySingle(model, { op: 'add', path: op.path, value: v });
      break;
    }
    case 'copy': {
      const v = wsApplySingle(model, { op: 'get', path: op.from });
      wsApplySingle(model, { op: 'add', path: op.path, value: v });
      break;
    }
    case 'test': {
      if (JSON.stringify(wsResolve(model, tokens)) !== JSON.stringify(op.value)) throw new Error('test failed ' + op.path);
      break;
    }
    case 'get': return wsClone(wsResolve(model, tokens));
    default: throw new Error('Unsupported op: ' + op.op);
  }
}
function applyJsonPatch(model, patches) {
  const next = wsClone(model || {});
  if (!Array.isArray(patches)) return next;
  for (const p of patches) wsApplySingle(next, p);
  return next;
}
/** Extract <json_patch> blocks; runtime-detect RFC 6902 (skip invalid). Returns array of patch-arrays. */
function extractJsonPatches(text) {
  const out = [];
  if (!text || typeof text !== 'string') return out;
  const re = /<json_patch>([\s\S]*?)<\/json_patch>/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const raw = (m[1] || '').trim();
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.every(p => p && typeof p === 'object' && typeof p.op === 'string' && typeof p.path === 'string')) {
        out.push(parsed);
      }
    } catch (e) { /* 非标准格式 → 跳过，UI 仍按原文展示 */ }
  }
  return out;
}
function applyJsonPatchesFromText(model, text) {
  let next = wsClone(model || {});
  for (const block of extractJsonPatches(text)) next = applyJsonPatch(next, block);
  return next;
}

/* ── Tavern Helper <UpdateVariables> 解析（前端镜像后端实现） ──
 * SELECT_ADD/SET("arrPath","keyField","keyVal","field","value") 操作数组内记录；
 * 3 参简写 ("dotted.path","field","value") 直接设嵌套对象值；
 * field 支持点分隔嵌套（如 "optional.命定之人"）。 */
function wsCoerceArg(raw) {
  const t = (raw || '').trim();
  if (t.length >= 2 && t[0] === '"' && t[t.length - 1] === '"') return { kind: 'str', value: t.slice(1, -1) };
  if (t === 'true') return { kind: 'bool', value: true };
  if (t === 'false') return { kind: 'bool', value: false };
  if (t === 'null') return { kind: 'null', value: null };
  if (/^-?\d+(\.\d+)?$/.test(t)) return { kind: 'num', value: Number(t) };
  return { kind: 'raw', value: t };
}
function wsCoerceValue(raw) { return wsCoerceArg(raw).value; }
function wsParseSqlArgs(s) {
  const args = []; let inStr = false, depth = 0, cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"') { inStr = !inStr; cur += c; }
    else if (c === '(' && !inStr) { depth++; cur += c; }
    else if (c === ')' && !inStr) { depth--; cur += c; }
    else if (c === ',' && !inStr && depth === 0) { args.push(cur.trim()); cur = ''; }
    else cur += c;
  }
  if (cur.trim()) args.push(cur.trim());
  return args;
}
function wsSetNested(obj, field, value) {
  const parts = String(field).split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (WS_FORBIDDEN.has(p)) return;
    if (cur[p] == null || typeof cur[p] !== 'object') cur[p] = {};
    cur = cur[p];
  }
  const last = parts[parts.length - 1];
  if (!WS_FORBIDDEN.has(last)) cur[last] = value;
}
function wsResolveObj(model, dotPath) {
  const parts = String(dotPath).split('.');
  let cur = model;
  for (const p of parts) {
    if (WS_FORBIDDEN.has(p)) return undefined;
    if (cur[p] == null || typeof cur[p] !== 'object') cur[p] = {};
    cur = cur[p];
  }
  return cur;
}
function wsResolveArr(model, dotPath) {
  const parts = String(dotPath).split('.');
  let cur = model;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (WS_FORBIDDEN.has(p)) return undefined;
    if (i === parts.length - 1) { if (cur[p] == null) cur[p] = []; return cur[p]; }
    if (cur[p] == null || typeof cur[p] !== 'object') cur[p] = {};
    cur = cur[p];
  }
  return cur;
}
function wsParseUpdateVariables(text) {
  const ops = [];
  if (!text || typeof text !== 'string') return ops;
  const re = /<UpdateVariables>([\s\S]*?)<\/UpdateVariables>/g;
  let block;
  while ((block = re.exec(text)) !== null) {
    const stmts = block[1].split(';').map(s => s.trim()).filter(Boolean);
    for (const stmt of stmts) {
      const m = stmt.match(/^(?:@\.|var_update\.)?SELECT_(ADD|SET|GET)\s*\(([\s\S]*)\)$/i);
      if (!m) continue;
      const args = wsParseSqlArgs(m[2]);
      if (!args.length) continue;
      ops.push({ type: m[1].toUpperCase(), args });
    }
  }
  return ops;
}
function wsApplyUpdateVariables(model, ops) {
  const m = (model && typeof model === 'object') ? model : {};
  if (!Array.isArray(ops)) return m;
  for (const op of ops) {
    const type = String(op.type || '').toUpperCase();
    if (type === 'GET') continue;
    const args = Array.isArray(op.args) ? op.args : [];
    if (args.length === 3) {
      const p1 = wsCoerceArg(args[0]).value, p2 = wsCoerceArg(args[1]).value, val = wsCoerceValue(args[2]);
      if (p1 == null || p2 == null) continue;
      const container = wsResolveObj(m, String(p1));
      if (container === undefined) continue;
      wsSetNested(container, String(p2), val);
      continue;
    }
    if (args.length >= 5) {
      const arrPath = wsCoerceArg(args[0]).value, keyField = wsCoerceArg(args[1]).value, keyVal = wsCoerceArg(args[2]).value,
            field = wsCoerceArg(args[3]).value, value = wsCoerceValue(args[4]);
      if (arrPath == null || keyField == null || field == null) continue;
      const arr = wsResolveArr(m, String(arrPath));
      if (Array.isArray(arr)) {
        let rec = arr.find(r => r && r[keyField] === keyVal);
        if (!rec) { rec = {}; rec[keyField] = keyVal; arr.push(rec); }
        wsSetNested(rec, String(field), value);
      } else if (arr && typeof arr === 'object') {
        wsSetNested(arr, String(field), value);
      }
    }
  }
  return m;
}
/** 合并两种变量格式（<json_patch> RFC6902 + <UpdateVariables> SQL 方言）统一应用。 */
function applyWorldStateFromText(model, text) {
  let m = applyJsonPatchesFromText(model, text);
  return wsApplyUpdateVariables(m, wsParseUpdateVariables(text));
}

/** 从 AppState.currentCharacter 解析 UI 契约（MVU vs 旧状态栏）。 */
function getCharUIHintsFromState() {
  const c = AppState.currentCharacter;
  if (!c) return { hasMVU: false, requiresStatus: false };
  let hints = null;
  try { const meta = c.metadata ? JSON.parse(c.metadata) : null; if (meta && meta.ui_hints) hints = meta.ui_hints; } catch {}
  if (hints && typeof hints === 'object') return { hasMVU: !!hints.hasMVU, requiresStatus: !!hints.requiresStatus };
  const hasMVU = c.markup_mode === 'game-xml';
  return { hasMVU, requiresStatus: !hasMVU };
}

/** AI 消息提交时调用：把 <json_patch> / <UpdateVariables> 应用到世界状态并持久化。 */
async function applyWorldStateFromMessage(content) {
  if (!AppState.currentConversation) return;
  const blocks = extractJsonPatches(content || '');
  const uvOps = wsParseUpdateVariables(content || '');
  if (blocks.length === 0 && uvOps.length === 0) return;
  try {
    const merged = applyWorldStateFromText(AppState.worldState, content || '');
    AppState.worldState = merged;
    if (typeof AppScript !== 'undefined' && AppScript.saveWorldState) {
      await AppScript.saveWorldState(merged);
    }
    renderWorldStatePanel();
    showToastSafe('世界状态已更新 (' + (blocks.flat().length + uvOps.length) + ' 项更新)', 'info');
  } catch (e) {
    console.error('[WorldState] apply error:', e);
    showToastSafe('世界状态补丁应用失败: ' + e.message, 'error');
  }
}

/** 对话加载时恢复世界状态。 */
async function loadWorldState() {
  if (!AppState.currentConversation) return;
  try {
    if (typeof AppScript !== 'undefined' && AppScript.getWorldState) {
      const ws = await AppScript.getWorldState();
      AppState.worldState = (ws && typeof ws === 'object') ? ws : {};
    }
    AppState.worldStateLoaded = true;
    renderWorldStatePanel();
  } catch (e) { AppState.worldState = {}; renderWorldStatePanel(); }
}

/** 重新读取初始变量：从开场白（首条 assistant 消息）的 <json_patch>/<UpdateVariables> 重新播种。 */
async function seedWorldStateFromGreeting() {
  if (!AppState.currentConversation) return;
  const greeting = AppState.messages.find(m => m.role === 'assistant');
  const seeded = applyWorldStateFromText({}, greeting ? greeting.content : '');
  AppState.worldState = seeded;
  if (typeof AppScript !== 'undefined' && AppScript.saveWorldState) await AppScript.saveWorldState(seeded);
  renderWorldStatePanel();
  showToastSafe('已重新读取初始变量', 'success');
}

/** 重新处理变量：按全部消息顺序重放所有 <json_patch>/<UpdateVariables> 重建世界状态。 */
async function reprocessWorldState() {
  if (!AppState.currentConversation) return;
  let model = {};
  for (const m of AppState.messages) {
    if (m.role !== 'assistant') continue;
    try { model = applyWorldStateFromText(model, m.content || ''); } catch (e) { /* skip bad */ }
  }
  AppState.worldState = model;
  if (typeof AppScript !== 'undefined' && AppScript.saveWorldState) await AppScript.saveWorldState(model);
  renderWorldStatePanel();
  showToastSafe('已重新处理全部变量', 'success');
}

/** 清除旧楼层变量：重置为空树。 */
async function clearWorldState() {
  if (!AppState.currentConversation) return;
  AppState.worldState = {};
  if (typeof AppScript !== 'undefined' && AppScript.saveWorldState) await AppScript.saveWorldState({});
  renderWorldStatePanel();
  showToastSafe('已清除楼层变量', 'info');
}

/** 手动改值：path 为 RFC6902 风格绝对路径，如 /contact/樱羽艾玛/relationship/affection */
async function setWorldVarByPath(path, value) {
  if (!AppState.currentConversation) return;
  try {
    const next = applyJsonPatch(AppState.worldState, [{ op: 'add', path, value }]);
    AppState.worldState = next;
    if (typeof AppScript !== 'undefined' && AppScript.saveWorldState) await AppScript.saveWorldState(next);
    renderWorldStatePanel();
  } catch (e) { showToastSafe('设置变量失败: ' + e.message, 'error'); }
}

/** 渲染积木式 MVU 状态面板：选项卡 + 语义组件 + 空字段 + 变更标记 */
function renderWorldStatePanel() {
  const body = document.getElementById('worldStateBody');
  if (!body) return;
  updateWorldStateFloatVisibility();
  const ws = AppState.worldState;
  const isEngine = AppState.currentCharacter && AppState.currentCharacter.markup_mode === 'game-xml';
  const ui = getCharUIHintsFromState();
  const hasData = ws && Object.keys(ws).length > 0;

  // ── Change detection: snapshot before build, diff when both old & new exist ──
  const prev = AppState._prevWorldState || null;
  const changes = (prev && hasData) ? diffWorldState(prev, ws) : {};
  snapshotWorldState(); // save current for next render

  if (!isEngine && !ui.hasMVU && !hasData) {
    body.innerHTML = '<div class="ws-empty">当前角色不是 engine / MVU 卡，无世界状态。</div>';
    return;
  }
  if (!hasData) {
    body.innerHTML = '<div class="ws-empty">世界状态为空。发送消息后 AI 会输出变量更新自动填充，或点「重新读取初始变量」从开场白播种。</div>';
    AppState._prevWorldState = null;
    return;
  }

  // Load mvu_meta from current character
  const mvuMeta = getMvuMetaFromState();

  // Classify top-level keys into semantic tab groups (including empty schema fields)
  const tabs = classifyWorldStateGroups(ws, mvuMeta);

  // Add empty sections from schema
  injectEmptySections(tabs, ws, mvuMeta);

  // Render tabs
  let html = '<div class="mvu-tabs">';
  tabs.forEach((tab, i) => {
    html += '<button class="mvu-tab' + (i === 0 ? ' active' : '') + '" data-mvu-tab="' + escapeHtml(tab.id) + '">' +
      escapeHtml(tab.icon) + ' ' + escapeHtml(tab.label) +
      (tab.count > 0 ? ' <span class="mvu-tab-badge">' + tab.count + '</span>' : '') +
      '</button>';
  });
  html += '</div>';

  // Render tab panels
  tabs.forEach((tab, i) => {
    html += '<div class="mvu-panel' + (i === 0 ? '' : ' hidden') + '" data-mvu-panel="' + escapeHtml(tab.id) + '">';
    tab.sections.forEach(section => {
      html += renderMvuSection(section, ws, changes);
    });
    html += '</div>';
  });

  body.innerHTML = html;

  // Bind tab clicks
  body.querySelectorAll('.mvu-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      body.querySelectorAll('.mvu-tab').forEach(b => b.classList.remove('active'));
      body.querySelectorAll('.mvu-panel').forEach(p => p.classList.add('hidden'));
      btn.classList.add('active');
      const panel = body.querySelector('[data-mvu-panel="' + btn.dataset.mvuTab + '"]');
      if (panel) panel.classList.remove('hidden');
    });
  });

  // Bind input changes for editable values
  body.querySelectorAll('.mvu-editable').forEach(input => {
    input.addEventListener('change', (e) => {
      const path = e.target.dataset.path;
      let val;
      if (e.target.type === 'number') {
        val = Number(e.target.value);
      } else if (e.target.type === 'checkbox') {
        val = e.target.checked;
      } else {
        val = e.target.value;
      }
      setWorldVarByPath(path, val);
    });
  });
}

/** Save a deep clone of current world_state as previous snapshot */
function snapshotWorldState() {
  try {
    AppState._prevWorldState = JSON.parse(JSON.stringify(AppState.worldState));
  } catch { AppState._prevWorldState = null; }
}

/**
 * Diff two world_state trees. Returns a flat map:
 *   { [dotPath]: 'new' | 'modified' | 'deleted' }
 * Only tracks leaf-level changes for display purposes.
 */
function diffWorldState(prev, cur) {
  const changes = {};
  if (!prev) return changes;
  const walked = new Set();

  function walkKeys(obj, prefix) {
    if (!obj || typeof obj !== 'object') return;
    for (const k of Object.keys(obj)) {
      const path = prefix ? prefix + '/' + k : '/' + k;
      const curVal = getByPath(cur, path);
      const prevVal = obj[k];
      if (curVal === undefined) {
        changes[path] = 'deleted';
      } else if (JSON.stringify(prevVal) !== JSON.stringify(curVal)) {
        changes[path] = 'modified';
        // Mark parent as modified too (for visual indicators on section/group)
        const parent = path.substring(0, path.lastIndexOf('/'));
        if (parent && !changes[parent]) changes[parent] = 'modified';
      }
      if (prevVal && typeof prevVal === 'object' && !Array.isArray(prevVal)) {
        walkKeys(prevVal, path);
      }
      walked.add(path);
    }
  }
  // Walk previous state to find deleted/modified
  walkKeys(prev, '');

  // Find newly added keys in cur that don't exist in prev
  function findNew(obj, prefix) {
    if (!obj || typeof obj !== 'object') return;
    for (const k of Object.keys(obj)) {
      const path = prefix ? prefix + '/' + k : '/' + k;
      if (!walked.has(path)) {
        const prevVal = getByPath(prev, path);
        if (prevVal === undefined) {
          changes[path] = 'new';
          const parent = path.substring(0, path.lastIndexOf('/'));
          if (parent && !changes[parent]) changes[parent] = 'modified';
        }
      }
      if (obj[k] && typeof obj[k] === 'object' && !Array.isArray(obj[k])) {
        findNew(obj[k], path);
      }
    }
  }
  findNew(cur, '');
  return changes;
}

function getByPath(obj, dotPath) {
  if (!dotPath || dotPath === '/') return obj;
  const segs = dotPath.split('/').filter(Boolean);
  let cur = obj;
  for (const s of segs) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = cur[s];
  }
  return cur;
}

/**
 * Inject empty sections from mvu_meta schema into tabs.
 * For each meta field NOT present in world_state, add a placeholder section
 * to the appropriate tab so users can see the full expected structure.
 */
function injectEmptySections(tabs, ws, mvuMeta) {
  if (!mvuMeta || !mvuMeta.fields) return;
  const visibleFields = Object.entries(mvuMeta.fields).filter(([k, v]) => !v.hidden);

  // Find which tab each role maps to
  const roleToTab = {
    character_list: 'characters',
    progress: 'progress',
    info: 'worldinfo',
    asset_list: 'assets',
    gauge: 'gauges',
    generic: 'other'
  };

  for (const [key, meta] of visibleFields) {
    // Check if this path exists in world_state
    const parts = key.split('.');
    let cur = ws;
    let exists = true;
    for (const p of parts) {
      if (cur === null || typeof cur !== 'object' || !(p in cur)) { exists = false; break; }
      cur = cur[p];
    }

    if (!exists) {
      const role = meta.role || 'generic';
      const tabId = roleToTab[role] || 'other';

      // Find or create the tab
      let tab = tabs.find(t => t.id === tabId);
      if (!tab) {
        const icons = { characters: '👥', progress: '📊', worldinfo: '🌍', assets: '📦', gauges: '⚖️', other: '📋' };
        tab = { id: tabId, icon: icons[tabId] || '📋', label: tabId === 'worldinfo' ? '世界' : tabId === 'gauges' ? '数值' : tabId === 'assets' ? '资产' : tabId === 'characters' ? '角色' : tabId === 'progress' ? '进度' : '其他', count: 0, sections: [] };
        tabs.push(tab);
      }

      // Check if this empty section is not already added
      if (!tab.sections.find(s => s.key === key)) {
        tab.sections.push({ key, data: null, meta, empty: true });
      }
    }
  }
}

/** Get mvu_meta from current character */
function getMvuMetaFromState() {
  const c = AppState.currentCharacter;
  if (!c) return null;
  try {
    if (c.mvu_meta && typeof c.mvu_meta === 'string') return JSON.parse(c.mvu_meta);
    if (c.mvu_meta && typeof c.mvu_meta === 'object') return c.mvu_meta;
  } catch {}
  return null;
}

/**
 * Classify world_state top-level keys into semantic tab groups.
 * Returns array of { id, icon, label, count, sections: [{ key, data, meta }] }
 */
function classifyWorldStateGroups(ws, mvuMeta) {
  const tabs = [];
  const assigned = new Set();

  // 1. Characters tab: keys whose data is Array of objects with "name" or whose meta role = character_list
  const charSections = [];
  for (const key of Object.keys(ws)) {
    if (assigned.has(key)) continue;
    const data = ws[key];
    const meta = mvuMeta && mvuMeta.fields ? (mvuMeta.fields[key] || findMetaByPath(mvuMeta.fields, key)) : null;
    const role = meta ? meta.role : inferRoleFromData(data, key);
    if (role === 'character_list') {
      charSections.push({ key, data, meta });
      assigned.add(key);
    }
  }
  // Also scan sub-paths for character lists (e.g. mc.stargazers under mc)
  for (const key of Object.keys(ws)) {
    if (assigned.has(key)) continue;
    const data = ws[key];
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      for (const subKey of Object.keys(data)) {
        const subData = data[subKey];
        const subPath = key + '.' + subKey;
        const meta = mvuMeta && mvuMeta.fields ? mvuMeta.fields[subPath] : null;
        const role = meta ? meta.role : inferRoleFromData(subData, subPath);
        if (role === 'character_list') {
          charSections.push({ key: subPath, data: subData, meta, parentKey: key });
          // Don't assign parent key — it might have other sub-keys for other tabs
        }
      }
    }
  }
  if (charSections.length > 0) {
    tabs.push({ id: 'characters', icon: '👥', label: '角色', count: countCharacters(charSections), sections: charSections });
  }

  // 2. Progress tab: chapter_manager, stage, phase etc.
  const progressSections = [];
  for (const key of Object.keys(ws)) {
    if (assigned.has(key)) continue;
    const data = ws[key];
    const meta = mvuMeta && mvuMeta.fields ? (mvuMeta.fields[key] || findMetaByPath(mvuMeta.fields, key)) : null;
    const role = meta ? meta.role : inferRoleFromData(data, key);
    if (role === 'progress') {
      progressSections.push({ key, data, meta });
      assigned.add(key);
    }
  }
  if (progressSections.length > 0) {
    tabs.push({ id: 'progress', icon: '📊', label: '进度', count: 0, sections: progressSections });
  }

  // 3. World info tab: time, location, weather, environment
  const infoSections = [];
  for (const key of Object.keys(ws)) {
    if (assigned.has(key)) continue;
    const data = ws[key];
    const meta = mvuMeta && mvuMeta.fields ? (mvuMeta.fields[key] || findMetaByPath(mvuMeta.fields, key)) : null;
    const role = meta ? meta.role : inferRoleFromData(data, key);
    if (role === 'info') {
      infoSections.push({ key, data, meta });
      assigned.add(key);
    }
  }
  // Also find info sub-keys
  for (const key of Object.keys(ws)) {
    if (assigned.has(key)) continue;
    const data = ws[key];
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      for (const subKey of Object.keys(data)) {
        const subData = data[subKey];
        const subPath = key + '.' + subKey;
        const meta = mvuMeta && mvuMeta.fields ? mvuMeta.fields[subPath] : null;
        const role = meta ? meta.role : inferRoleFromData(subData, subPath);
        if (role === 'info') {
          infoSections.push({ key: subPath, data: subData, meta, parentKey: key });
        }
      }
    }
  }
  if (infoSections.length > 0) {
    tabs.push({ id: 'worldinfo', icon: '🌍', label: '世界', count: 0, sections: infoSections });
  }

  // 4. Assets tab: ships, evidence, inventory, industry etc.
  const assetSections = [];
  for (const key of Object.keys(ws)) {
    if (assigned.has(key)) continue;
    const data = ws[key];
    const meta = mvuMeta && mvuMeta.fields ? (mvuMeta.fields[key] || findMetaByPath(mvuMeta.fields, key)) : null;
    const role = meta ? meta.role : inferRoleFromData(data, key);
    if (role === 'asset_list') {
      assetSections.push({ key, data, meta });
      assigned.add(key);
    }
  }
  // Also find asset sub-keys
  for (const key of Object.keys(ws)) {
    if (assigned.has(key)) continue;
    const data = ws[key];
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      for (const subKey of Object.keys(data)) {
        const subData = data[subKey];
        const subPath = key + '.' + subKey;
        const meta = mvuMeta && mvuMeta.fields ? mvuMeta.fields[subPath] : null;
        const role = meta ? meta.role : inferRoleFromData(subData, subPath);
        if (role === 'asset_list') {
          assetSections.push({ key: subPath, data: subData, meta, parentKey: key });
        }
      }
    }
  }
  if (assetSections.length > 0) {
    tabs.push({ id: 'assets', icon: '📦', label: '资产', count: countAssetItems(assetSections), sections: assetSections });
  }

  // 5. Gauges tab: standings, reputation, numeric values
  const gaugeSections = [];
  for (const key of Object.keys(ws)) {
    if (assigned.has(key)) continue;
    const data = ws[key];
    const meta = mvuMeta && mvuMeta.fields ? (mvuMeta.fields[key] || findMetaByPath(mvuMeta.fields, key)) : null;
    const role = meta ? meta.role : inferRoleFromData(data, key);
    if (role === 'gauge') {
      gaugeSections.push({ key, data, meta });
      assigned.add(key);
    }
  }
  // Also find gauge sub-keys (e.g. standings.*)
  for (const key of Object.keys(ws)) {
    if (assigned.has(key)) continue;
    const data = ws[key];
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      // Check if all values are numbers → gauge group
      const vals = Object.values(data);
      if (vals.length > 0 && vals.every(v => typeof v === 'number')) {
        const meta = mvuMeta && mvuMeta.fields ? (mvuMeta.fields[key] || findMetaByPath(mvuMeta.fields, key)) : null;
        const role = meta ? meta.role : 'gauge';
        if (role === 'gauge') {
          gaugeSections.push({ key, data, meta });
          assigned.add(key);
        }
      } else {
        // Sub-key scan for gauge paths like standings.terran_empire
        const subGauges = {};
        for (const subKey of Object.keys(data)) {
          const subPath = key + '.' + subKey;
          const meta = mvuMeta && mvuMeta.fields ? mvuMeta.fields[subPath] : null;
          if (meta && meta.role === 'gauge') {
            subGauges[subKey] = data[subKey];
          }
        }
        if (Object.keys(subGauges).length > 0) {
          gaugeSections.push({ key, data: subGauges, meta: { role: 'gauge' }, parentKey: key });
        }
      }
    }
  }
  if (gaugeSections.length > 0) {
    tabs.push({ id: 'gauges', icon: '⚖️', label: '数值', count: 0, sections: gaugeSections });
  }

  // 6. Other tab: everything remaining (generic KV)
  const otherSections = [];
  for (const key of Object.keys(ws)) {
    if (assigned.has(key)) continue;
    const data = ws[key];
    const meta = mvuMeta && mvuMeta.fields ? (mvuMeta.fields[key] || findMetaByPath(mvuMeta.fields, key)) : null;
    // Skip hidden fields
    if (meta && meta.hidden) continue;
    otherSections.push({ key, data, meta });
  }
  if (otherSections.length > 0) {
    tabs.push({ id: 'other', icon: '📋', label: '其他', count: 0, sections: otherSections });
  }

  // If no tabs at all (all hidden), add a generic one
  if (tabs.length === 0) {
    tabs.push({ id: 'other', icon: '📋', label: '状态', count: 0,
      sections: Object.keys(ws).map(key => ({ key, data: ws[key], meta: null })) });
  }

  return tabs;
}

/** Find a mvu_meta field by dot-path (e.g. "mc.stargazers" matches "mc.stargazers" or partial) */
function findMetaByPath(fields, key) {
  if (!fields) return null;
  if (fields[key]) return fields[key];
  // Try matching the last segment
  const seg = key.split('.').pop();
  for (const [k, v] of Object.entries(fields)) {
    if (k.endsWith('.' + seg) || k === seg) return v;
  }
  return null;
}

/** Infer semantic role from data shape and key name */
function inferRoleFromData(data, key) {
  if (data === null || data === undefined) return 'generic';
  // Array of objects with name → character_list
  if (Array.isArray(data)) {
    if (data.length > 0 && typeof data[0] === 'object' && data[0] !== null && ('name' in data[0] || 'designation' in data[0])) {
      if (/stargazer|character|contact|crew|member|person|girl|boy|npc/i.test(key)) return 'character_list';
      return 'asset_list';
    }
    return 'asset_list';
  }
  if (typeof data === 'number') return 'gauge';
  if (typeof data === 'string') return 'info';
  if (typeof data === 'boolean') return 'generic';
  if (typeof data === 'object') {
    const keys = Object.keys(data);
    // All values are numbers → gauge
    if (keys.length > 0 && keys.every(k => typeof data[k] === 'number')) return 'gauge';
    // Has chapter/stage/phase → progress
    if (keys.some(k => /chapter|stage|phase|playthrough/i.test(k))) return 'progress';
    // Has time/location/weather → info
    if (keys.some(k => /time|location|weather|period|environment/i.test(k))) return 'info';
    // Has name+affection/lust → character_list
    if (keys.some(k => /affection|lust|relationship|end_flag/i.test(k))) return 'character_list';
    // Has evidence/inventory → asset_list
    if (keys.some(k => /evidence|inventory|item/i.test(k))) return 'asset_list';
  }
  return 'generic';
}

function countCharacters(sections) {
  let n = 0;
  for (const s of sections) {
    if (Array.isArray(s.data)) n += s.data.length;
    else if (s.data && typeof s.data === 'object') n += Object.keys(s.data).length;
  }
  return n;
}

function countAssetItems(sections) {
  let n = 0;
  for (const s of sections) {
    if (Array.isArray(s.data)) n += s.data.length;
    else if (s.data && typeof s.data === 'object') n += Object.keys(s.data).length;
  }
  return n;
}

/** Render a single section within a tab */
function renderMvuSection(section, ws, changes) {
  const { key, data, meta, parentKey, empty } = section;
  // Skip hidden variables
  if (meta && meta.hidden) return '';
  const role = meta ? meta.role : (empty ? 'generic' : inferRoleFromData(data, key));
  const label = meta && meta.label ? meta.label : key.split('.').pop().replace(/_/g, ' ');

  // Check if this section has changes
  const sectionChanged = hasChangesForKey(changes, key);
  const cls = ['mvu-section'];
  if (empty) cls.push('mvu-section-empty');
  if (sectionChanged) cls.push('mvu-changed');

  let h = '<div class="' + cls.join(' ') + '" data-key="' + escapeHtml(key) + '">';
  h += '<div class="mvu-section-title"><span class="mvu-section-indicator"></span>' + escapeHtml(label) + '</div>';

  if (empty) {
    h += '<div class="mvu-empty-state">' + renderEmptyPlaceholder(role, meta) + '</div>';
  } else {
    switch (role) {
      case 'character_list':
        h += renderMvuCharacterList(data, key, meta, changes);
        break;
      case 'progress':
        h += renderProgressBlock(data, key, meta, changes);
        break;
      case 'info':
        h += renderInfoBar(data, key, meta, changes);
        break;
      case 'asset_list':
        h += renderAssetList(data, key, meta, changes);
        break;
      case 'gauge':
        h += renderGaugeBlock(data, key, meta, changes);
        break;
      default:
        h += renderGenericKV(data, key, meta, changes);
        break;
    }
  }

  h += '</div>';
  return h;
}

/** Check if any change path starts with the given key prefix */
function hasChangesForKey(changes, key) {
  if (!changes || !key) return false;
  const prefix = '/' + key.replace(/\./g, '/');
  for (const path of Object.keys(changes)) {
    if (path === prefix || path.startsWith(prefix + '/')) return true;
  }
  return false;
}

/** Render a placeholder for an empty schema field */
function renderEmptyPlaceholder(role, meta) {
  const type = meta ? meta.type : 'dict';
  switch (type) {
    case 'list[dict]': case 'list[string]':
      return '<span class="mvu-empty-hint">（尚未填充）</span>';
    case 'int':
      return '<span class="mvu-placeholder-val">0</span>';
    case 'string':
      return '<span class="mvu-empty-hint">—</span>';
    default:
      return '<span class="mvu-empty-hint">（待初始化）</span>';
  }
}

/** Check if a specific path has a change marker */
function isFieldChanged(changes, path) {
  if (!changes || !path) return false;
  // Normalize path: strip leading / and convert URL-encoded slashes
  const norm = path.replace(/^\//, '').replace(/%2F/g, '/');
  const searchPath = '/' + norm;
  return !!changes[searchPath];
}

/** ─── Component: Character list (card grid) ─── */
function renderMvuCharacterList(data, pathPrefix, meta, changes) {
  if (!data) return '<div class="mvu-empty">暂无角色数据</div>';
  let h = '<div class="mvu-char-grid">';

  if (Array.isArray(data)) {
    const keyField = (meta && meta.keyField) || 'name';
    data.forEach((item, i) => {
      if (typeof item !== 'object' || item === null) return;
      const name = item[keyField] || item.name || ('#' + i);
      h += renderCharacterCard(item, name, pathPrefix + '/' + i, meta, changes);
    });
  } else if (typeof data === 'object') {
    // Record<name, obj> format (e.g. contact from Zod schema)
    for (const [name, item] of Object.entries(data)) {
      if (typeof item !== 'object' || item === null) continue;
      h += renderCharacterCard(item, name, pathPrefix + '/' + encodeURIComponent(name), meta, changes);
    }
  }

  h += '</div>';
  return h;
}

function renderCharacterCard(item, name, pathPrefix, meta, changes) {
  const cardChanged = hasChangesForKey(changes, pathPrefix.replace(/^\//, ''));
  const avatarColor = stringToColor(name);
  let h = '<div class="mvu-char-card' + (cardChanged ? ' mvu-changed' : '') + '">';
  h += '<div class="mvu-char-avatar" style="background:' + avatarColor + '">' + escapeHtml(name.charAt(0)) + '</div>';
  h += '<div class="mvu-char-info">';
  h += '<div class="mvu-char-name">' + escapeHtml(name) + '</div>';

  // Render numeric fields as bars, string fields as text
  for (const [k, v] of Object.entries(item)) {
    if (k === 'name' || k === 'designation') continue;
    if (typeof v === 'number') {
      h += renderMiniBar(k, v, pathPrefix + '/' + encodeURIComponent(k), meta, isFieldChanged(changes, pathPrefix + '/' + encodeURIComponent(k)));
    } else if (typeof v === 'string' && v.length < 200) {
      const fieldChanged = isFieldChanged(changes, pathPrefix + '/' + encodeURIComponent(k));
      h += '<div class="mvu-char-field' + (fieldChanged ? ' mvu-field-changed' : '') + '"><span class="mvu-field-label">' + escapeHtml(k) + '</span>' +
        '<input class="mvu-editable mvu-field-string" type="text" value="' + escapeHtml(v) + '" data-path="' + escapeHtml(pathPrefix + '/' + encodeURIComponent(k)) + '"></div>';
    }
  }

  // Collapsible details for complex sub-objects
  const complexFields = Object.entries(item).filter(([k, v]) => typeof v === 'object' && v !== null && !Array.isArray(v));
  if (complexFields.length > 0) {
    h += '<details class="mvu-char-details"><summary>详情</summary>';
    for (const [k, v] of complexFields) {
      h += '<div class="mvu-sub-obj"><div class="mvu-sub-title">' + escapeHtml(k) + '</div>';
      h += renderGenericKV(v, pathPrefix + '/' + encodeURIComponent(k), null, changes);
      h += '</div>';
    }
    h += '</details>';
  }

  // Collapsible details for arrays
  const arrFields = Object.entries(item).filter(([k, v]) => Array.isArray(v));
  if (arrFields.length > 0) {
    h += '<details class="mvu-char-details"><summary>列表</summary>';
    for (const [k, v] of arrFields) {
      h += '<div class="mvu-sub-obj"><div class="mvu-sub-title">' + escapeHtml(k) + ' [' + v.length + ']</div>';
      h += renderGenericKV(v, pathPrefix + '/' + encodeURIComponent(k), null, changes);
      h += '</div>';
    }
    h += '</details>';
  }

  h += '</div></div>';
  return h;
}

/** ─── Component: Mini progress bar (for character numeric fields) ─── */
function renderMiniBar(label, value, path, meta, changed) {
  // Auto-range: try to detect if this is a 0-100, 0-1000, or unbounded value
  const max = value <= 100 ? 100 : value <= 1000 ? 1000 : Math.ceil(value * 1.2);
  const pct = Math.min(100, Math.max(0, (value / max) * 100));
  const color = pct >= 70 ? 'var(--mvu-bar-high, #4caf50)' : pct >= 30 ? 'var(--mvu-bar-mid, #ff9800)' : 'var(--mvu-bar-low, #f44336)';

  let h = '<div class="mvu-char-field mvu-bar-field' + (changed ? ' mvu-field-changed' : '') + '">';
  h += '<span class="mvu-field-label">' + escapeHtml(label) + '</span>';
  h += '<div class="mvu-mini-bar"><div class="mvu-mini-bar-fill" style="width:' + pct + '%;background:' + color + '"></div></div>';
  h += '<input class="mvu-editable mvu-field-num" type="number" value="' + value + '" data-path="' + escapeHtml(path) + '">';
  h += '</div>';
  return h;
}

/** ─── Component: Progress block (chapter_manager, stage) ─── */
function renderProgressBlock(data, pathPrefix, meta, changes) {
  if (!data || typeof data !== 'object') return renderGenericKV(data, pathPrefix, meta);
  let h = '<div class="mvu-progress">';

  // Key progress indicators
  const progressKeys = ['playthrough', 'chapter', 'stage', 'phase', 'scene_name', 'game_mode'];
  const dataKeys = Object.keys(data);
  const orderedKeys = [...progressKeys.filter(k => dataKeys.includes(k)), ...dataKeys.filter(k => !progressKeys.includes(k))];

  for (const k of orderedKeys) {
    const v = data[k];
    const path = pathPrefix + '/' + encodeURIComponent(k);
    if (typeof v === 'object' && v !== null) {
      // Nested (like stage: {phase: ...})
      h += '<div class="mvu-progress-item"><span class="mvu-field-label">' + escapeHtml(k) + '</span>';
      h += renderProgressBlock(v, path, null);
      h += '</div>';
    } else {
      h += '<div class="mvu-progress-item">';
      h += '<span class="mvu-field-label">' + escapeHtml(k) + '</span>';
      if (typeof v === 'number') {
        h += '<span class="mvu-progress-value">' + v + '</span>';
      } else {
        h += '<span class="mvu-progress-value">' + escapeHtml(String(v)) + '</span>';
      }
      h += '</div>';
    }
  }

  h += '</div>';
  return h;
}

/** ─── Component: Info bar (time, location, weather) ─── */
function renderInfoBar(data, pathPrefix, meta, changes) {
  if (!data || typeof data !== 'object') return renderGenericKV(data, pathPrefix, meta);
  let h = '<div class="mvu-info-grid">';

  for (const [k, v] of Object.entries(data)) {
    const path = pathPrefix + '/' + encodeURIComponent(k);
    if (typeof v === 'object' && v !== null) {
      // Nested info (like time: {current_time, day})
      h += '<div class="mvu-info-cell mvu-info-nested">';
      h += '<div class="mvu-info-label">' + escapeHtml(k) + '</div>';
      h += renderInfoBar(v, path, null);
      h += '</div>';
    } else {
      h += '<div class="mvu-info-cell">';
      h += '<div class="mvu-info-label">' + escapeHtml(k) + '</div>';
      h += '<div class="mvu-info-value">' + escapeHtml(String(v)) + '</div>';
      h += '</div>';
    }
  }

  h += '</div>';
  return h;
}

/** ─── Component: Asset list (ships, evidence, inventory) ─── */
function renderAssetList(data, pathPrefix, meta, changes) {
  if (!data) return '<div class="mvu-empty">暂无数据</div>';
  let h = '<div class="mvu-asset-list">';

  if (Array.isArray(data)) {
    data.forEach((item, i) => {
      if (typeof item !== 'object' || item === null) {
        h += '<div class="mvu-asset-row"><span class="mvu-asset-name">' + escapeHtml(String(item)) + '</span></div>';
        return;
      }
      const keyField = (meta && meta.keyField) || 'name';
      const name = item[keyField] || item.name || item.designation || ('#' + i);
      h += '<details class="mvu-asset-item"><summary>' + escapeHtml(String(name)) + '</summary>';
      h += renderGenericKV(item, pathPrefix + '/' + i, null);
      h += '</details>';
    });
  } else if (typeof data === 'object') {
    for (const [name, item] of Object.entries(data)) {
      if (typeof item !== 'object' || item === null) {
        h += '<div class="mvu-asset-row"><span class="mvu-asset-name">' + escapeHtml(name) + '</span>' +
          '<span class="mvu-asset-val">' + escapeHtml(String(item)) + '</span></div>';
        continue;
      }
      h += '<details class="mvu-asset-item"><summary>' + escapeHtml(name) + '</summary>';
      h += renderGenericKV(item, pathPrefix + '/' + encodeURIComponent(name), null);
      h += '</details>';
    }
  }

  h += '</div>';
  return h;
}

/** ─── Component: Gauge block (standings, numeric values) ─── */
function renderGaugeBlock(data, pathPrefix, meta, changes) {
  if (!data || typeof data !== 'object') return renderGenericKV(data, pathPrefix, meta, changes);
  let h = '<div class="mvu-gauge-grid">';

  for (const [k, v] of Object.entries(data)) {
    const path = pathPrefix + '/' + encodeURIComponent(k);
    if (typeof v === 'number') {
      const max = v <= 100 ? 100 : v <= 1000 ? 1000 : Math.ceil(v * 1.2);
      const pct = Math.min(100, Math.max(0, (v / max) * 100));
      const color = pct >= 70 ? 'var(--mvu-bar-high, #4caf50)' : pct >= 30 ? 'var(--mvu-bar-mid, #ff9800)' : 'var(--mvu-bar-low, #f44336)';
      const changed = isFieldChanged(changes, path);
      h += '<div class="mvu-gauge-row' + (changed ? ' mvu-field-changed' : '') + '">';
      h += '<span class="mvu-gauge-label">' + escapeHtml(k.replace(/_/g, ' ')) + '</span>';
      h += '<div class="mvu-gauge-bar"><div class="mvu-gauge-fill" style="width:' + pct + '%;background:' + color + '"></div></div>';
      h += '<input class="mvu-editable mvu-gauge-input" type="number" value="' + v + '" data-path="' + escapeHtml(path) + '">';
      h += '</div>';
    } else {
      h += '<div class="mvu-gauge-row">';
      h += '<span class="mvu-gauge-label">' + escapeHtml(k) + '</span>';
      h += '<span class="mvu-gauge-val">' + escapeHtml(String(v)) + '</span>';
      h += '</div>';
    }
  }

  h += '</div>';
  return h;
}

/** ─── Component: Generic key-value (fallback) ─── */
function renderGenericKV(data, pathPrefix, meta, changes) {
  if (data === null || data === undefined) return '';
  if (typeof data !== 'object') {
    const val = (typeof data === 'string') ? data : JSON.stringify(data);
    const isNum = typeof data === 'number';
    return '<div class="mvu-leaf">' +
      '<input class="mvu-editable' + (isNum ? ' mvu-field-num' : ' mvu-field-string') + '" type="' + (isNum ? 'number' : 'text') + '" value="' + escapeHtml(String(val)) + '" data-path="' + escapeHtml(pathPrefix) + '">' +
      '</div>';
  }
  if (Array.isArray(data)) {
    let h = '';
    data.forEach((item, i) => {
      h += '<div class="mvu-arr-item">';
      if (typeof item === 'object' && item !== null) {
        h += '<details><summary>[' + i + ']</summary>' + renderGenericKV(item, pathPrefix + '/' + i, null) + '</details>';
      } else {
        h += '<span class="mvu-arr-index">[' + i + ']</span> ' + renderGenericKV(item, pathPrefix + '/' + i, null);
      }
      h += '</div>';
    });
    return h;
  }
  let h = '';
  for (const [k, v] of Object.entries(data)) {
    // Skip hidden fields
    if (meta && meta.fields && meta.fields[k] && meta.fields[k].hidden) continue;
    const path = pathPrefix + '/' + encodeURIComponent(k);
    if (typeof v === 'number') {
      h += '<div class="mvu-leaf"><span class="mvu-key">' + escapeHtml(k) + '</span>' +
        '<input class="mvu-editable mvu-field-num" type="number" value="' + v + '" data-path="' + escapeHtml(path) + '"></div>';
    } else if (typeof v === 'string') {
      h += '<div class="mvu-leaf"><span class="mvu-key">' + escapeHtml(k) + '</span>' +
        '<input class="mvu-editable mvu-field-string" type="text" value="' + escapeHtml(v) + '" data-path="' + escapeHtml(path) + '"></div>';
    } else if (typeof v === 'boolean') {
      h += '<div class="mvu-leaf"><span class="mvu-key">' + escapeHtml(k) + '</span>' +
        '<input class="mvu-editable" type="checkbox"' + (v ? ' checked' : '') + ' data-path="' + escapeHtml(path) + '"></div>';
    } else if (v && typeof v === 'object') {
      h += '<details class="mvu-details"><summary class="mvu-key">' + escapeHtml(k) + '</summary>' +
        renderGenericKV(v, path, null) + '</details>';
    }
  }
  return h;
}

/** Deterministic color from string (for avatar placeholders) */
function stringToColor(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
  const hue = Math.abs(hash % 360);
  return 'hsl(' + hue + ', 55%, 45%)';
}

/**
 * 检测并渲染 markdown 表格
 * 将表格替换为占位符 %%TABLE_N%%，HTML 存入 placeholders 数组
 */
function renderMarkdownTables(text, placeholders) {
  if (!text) return text;
  const lines = text.split('\n');
  const result = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // 检测表格行
    if (line.trim().match(/^\|.+\|$/) && (line.match(/\|/g) || []).length >= 2) {
      const tableLines = [line];
      let j = i + 1;
      while (j < lines.length && lines[j].trim().match(/^\|.+\|$/)) {
        tableLines.push(lines[j]);
        j++;
      }
      if (tableLines.length >= 2) {
        const tableHtml = renderTable(tableLines);
        if (tableHtml) {
          const idx = placeholders.length;
          placeholders.push(tableHtml);
          result.push(`%%TABLE_${idx}%%`);
          i = j;
          continue;
        }
      }
    }
    result.push(line);
    i++;
  }
  return result.join('\n');
}

function renderTable(lines) {
  const cellsRows = lines
    .map(l => l.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim()))
    .filter(cells => !cells.every(c => /^[\-:]+$/.test(c))); // 跳过分隔行

  if (cellsRows.length < 1) return null;

  let html = '<table class="md-table">';
  cellsRows.forEach((cells, idx) => {
    if (idx === 0) {
      html += '<thead><tr>' + cells.map(c => `<th>${escapeHtml(c)}</th>`).join('') + '</tr></thead><tbody>';
    } else {
      html += '<tr>' + cells.map(c => `<td>${escapeHtml(c)}</td>`).join('') + '</tr>';
    }
  });
  html += '</tbody></table>';
  return html;
}

/**
 * 渲染主Agent调试卡片（含思维链、完整输出）
 */
function renderMainAgentDebugEntry(formatted, rawContent, timeStr, roundNum) {
  const entryId = 'debug-main-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);

  // Summary line
  let summary = `[${(timeStr || '').slice(11, 16) || '--:--'}] `;
  if (rawContent) {
    const firstLine = rawContent.split('\n')[0].replace(/^###\s*mood\s*\n?/, '').trim().slice(0, 60);
    summary += firstLine || '(空内容)';
  }
  summary += ' ...';

  let card = `<div class="debug-card" id="${entryId}">
    <div class="debug-card-header" onclick="toggleDebugCard('${entryId}')">
      <span class="debug-card-arrow">&#9654;</span>
      <span class="debug-card-round">第${roundNum}轮</span>
      <span class="debug-card-summary">${escapeHtml(summary)}</span>
      <span class="debug-card-time">${timeStr || ''}</span>
    </div>
    <div class="debug-card-body" style="display:none">`;

  // Raw content
  if (rawContent) {
    card += `<div class="debug-section">
      <div class="debug-section-title">主AI完整输出</div>
      <pre class="debug-pre" style="font-size:var(--debug-font,13px)">${escapeHtml(rawContent)}</pre>
    </div>`;
  }

  // Reasoning (思维链)
  if (formatted && formatted.reasoning) {
    card += `<div class="debug-section" style="border-left:3px solid #f0a040">
      <div class="debug-section-title" style="color:#f0a040">思维链 (Chain-of-Thought)</div>
      <pre class="debug-pre" style="font-size:var(--debug-font,13px);background:rgba(32,24,0,0.3)">${escapeHtml(formatted.reasoning)}</pre>
    </div>`;
  }

  // Parsed JSON
  if (formatted) {
    card += `<div class="debug-section">
      <div class="debug-section-title" style="color:var(--text-muted)">解析后的 JSON</div>
      <pre class="debug-pre" style="font-size:var(--debug-font,11px)">${escapeHtml(JSON.stringify(formatted, null, 2))}</pre>
    </div>`;
  }

  card += `</div></div>`;
  return card;
}

/**
 * 渲染管家AI调试卡片（含处理结果、思维链）
 */
function renderButlerDebugEntry(butlerResult, timeStr, roundNum) {
  if (!butlerResult) return '';
  const entryId = 'debug-butler-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);

  // Summary line
  let summary = `[${(timeStr || '').slice(11, 16) || '--:--'}] `;
  if (butlerResult.mood) summary += '氛围:' + butlerResult.mood + ' ';
  if (butlerResult.portrait) summary += (butlerResult.portrait.name || butlerResult.portrait.map?.(p => p.name).join(',') || 'portrait') + ' ';
  if (butlerResult.triggerImage) summary += 'CG ';
  if (butlerResult.actions?.length) summary += butlerResult.actions.length + '选项 ';
  summary = summary.trim() || '(无内容)';

  let card = `<div class="debug-card" id="${entryId}">
    <div class="debug-card-header" onclick="toggleDebugCard('${entryId}')">
      <span class="debug-card-arrow">&#9654;</span>
      <span class="debug-card-round">第${roundNum}轮</span>
      <span class="debug-card-summary">${escapeHtml(summary)}</span>
      <span class="debug-card-time">${timeStr || ''}</span>
    </div>
    <div class="debug-card-body" style="display:none">`;

  // Butler result JSON
  card += `<div class="debug-section" style="border-left:3px solid #40f0a0">
    <div class="debug-section-title" style="color:#40f0a0">管家AI 处理结果</div>`;
  card += `<pre class="debug-pre" style="font-size:var(--debug-font,13px);background:rgba(0,32,24,0.3);max-height:400px;overflow-y:auto">${escapeHtml(JSON.stringify(butlerResult, null, 2))}</pre>`;

  // Highlight fixedText separately for easy inspection
  if (butlerResult.fixedText && typeof butlerResult.fixedText === 'string' && butlerResult.fixedText.length > 10) {
    card += `<div class="debug-section-title" style="color:#40f0a0;margin-top:8px">fixedText（修复后全文）${butlerResult.fixedText.length}字符</div>`;
    card += `<pre class="debug-pre" style="font-size:var(--debug-font,13px);background:rgba(0,32,24,0.3);max-height:400px;overflow-y:auto;white-space:pre-wrap">${escapeHtml(butlerResult.fixedText)}</pre>`;
  } else if (butlerResult.fixedText !== undefined) {
    card += `<div class="debug-section-title" style="color:#f04040;margin-top:8px">fixedText 为空（管家未检测到需要修复的格式问题）</div>`;
  }

  // Butler thinking
  if (butlerResult.thinking) {
    card += `<div class="debug-section-title" style="color:#a0f040;margin-top:8px">管家AI 思维链</div>`;
    card += `<pre class="debug-pre" style="font-size:var(--debug-font,13px);background:rgba(16,32,0,0.3);max-height:400px;overflow-y:auto">${escapeHtml(butlerResult.thinking)}</pre>`;
  }
  // Butler system & user prompt (for debugging instructions)
  if (butlerResult._debugButlerPrompt) {
    card += `<div class="debug-section-title" style="color:#f0a040;margin-top:8px">管家AI - System Prompt</div>`;
    card += `<pre class="debug-pre" style="font-size:var(--debug-font,12px);background:rgba(32,16,0,0.3);max-height:300px;overflow-y:auto;white-space:pre-wrap">${escapeHtml(butlerResult._debugButlerPrompt.system)}</pre>`;
    card += `<div class="debug-section-title" style="color:#f0a040;margin-top:8px">管家AI - User Prompt</div>`;
    card += `<pre class="debug-pre" style="font-size:var(--debug-font,12px);background:rgba(32,16,0,0.3);max-height:300px;overflow-y:auto;white-space:pre-wrap">${escapeHtml(butlerResult._debugButlerPrompt.user)}</pre>`;
  }
  card += `</div>`;

  card += `</div></div>`;
  return card;
}

function renderPlainText(text) {
  if (!text) return '';
  return escapeHtml(text).replace(/\n/g, '<br>');
}

// ============ 发送消息 ============

async function sendMessage() {
  const input = DOM.messageInput();
  const content = input.value.trim();

  // 如果正在生成中，按钮变为"停止"，点击后中止
  if (AppState.isGenerating) {
    await abortGeneration();
    return;
  }

  if (!content) return;
  if (!AppState.currentConversation) {
    showToast('请先选择一个角色开始对话', 'warning');
    return;
  }

  // ===== 处理斜杠指令 =====
  if (content.startsWith('/')) {
    const handled = handleSlashCommand(content);
    if (handled) {
      // 命中 app 内置指令（/hide /unhide /restart /export）
      input.value = '';
      updateSendButton();
      return;
    }
    // 非 app 内置指令 -> 交给 STScript 引擎执行（脚本命令/变量/宏）
    try {
      const result = await STScript.run(content, {
        conversationId: AppState.currentConversation.id,
        userId: AppState.userProfile ? AppState.userProfile.id : null,
      });
      // 引擎已自行处理 UI 反馈；未知命令会返回 unknown=true 并提示
      if (result && result.unknown) {
        showToast(result.message || `未支持指令: ${content.split(/\s+/)[0]}`, 'warning');
      }
    } catch (err) {
      showToast('脚本执行出错: ' + (err && err.message ? err.message : err), 'error');
    }
    input.value = '';
    updateSendButton();
    return;
  }

  AppState.isGenerating = true;
  input.value = '';
  updateSendButton();

  // 楼层计数
  AppState.roundCounter++;
  const currentRound = AppState.roundCounter;

  // 立即显示用户消息
  const userMsg = {
    id: 'temp-' + Date.now(),
    role: 'user',
    content,
    formatted: {},
    hidden: 0,
    created_at: new Date().toISOString(),
  };
  AppState.messages.push(userMsg);
  DOM.messagesArea().appendChild(createMessageElement(userMsg, currentRound));
  scrollToBottom();

  // Token 统计：用户消息不再手动计算，等后端返回精确统计
  // 在AI回复完成时，onDone回调会更新tokenStats

  // 创建 AI 回复占位（流式填充）
  const aiMsgId = 'stream-' + Date.now();
  const aiMsgDiv = document.createElement('div');
  aiMsgDiv.className = 'story-block assistant';
  aiMsgDiv.dataset.id = aiMsgId;
  aiMsgDiv.dataset.round = currentRound;

  // 流式内容区域（简单文本显示，不受 Gal Game 风格影响）
  aiMsgDiv.innerHTML = `
    <div class="narration-text ai-streaming">
      <div class="typing-indicator"><span></span><span></span><span></span></div>
    </div>
    <div class="ai-time"></div>
  `;
  DOM.messagesArea().appendChild(aiMsgDiv);
  scrollToBottom();

  // 流式累积文本
  let streamText = '';
  let isStreaming = true;

  try {
    await ChatAPI.stream(
      AppState.currentConversation.id,
      content,
      null,
      {
        onUserMessage: (msg) => {
          // 服务端已存储用户消息
          // console.log('[Stream] User message stored:', msg.id);
        },
        onToken: (token) => {
          if (!isStreaming) return;
          streamText += token;
          // 不显示裸文本，保持打字指示器直到完成
        },
        onDone: (result) => {
          // 流式完成 - 用 Gal Game 格式渲染主窗口
          processAIResponse(result);

          if (result.formatted && typeof result.formatted === 'object') {
            aiMsgDiv.innerHTML = renderAIBlock(result.formatted, result.content, new Date().toISOString());
            // 向调试面板推送完整输出
            appendDebugEntry(result.formatted, result.content, formatTime(new Date().toISOString()), result.butler);
          } else {
            aiMsgDiv.innerHTML = renderAIBlock(null, result.content, new Date().toISOString());
          }

          // Trigger TTS if enabled
          try {
            const fmt = typeof result.formatted === 'string' ? JSON.parse(result.formatted) : result.formatted;
            if (fmt && fmt.segments) {
              // Store segments on the message div for replay
              aiMsgDiv.dataset.ttsSegments = JSON.stringify(fmt.segments);
              ttsPlaySegments(fmt.segments, { msgDiv: aiMsgDiv });
            }
          } catch (e) { /* TTS not critical */ }

          // Add replay button
          const replayBtn = document.createElement('button');
          replayBtn.className = 'btn btn-sm tts-replay-btn';
          replayBtn.innerHTML = '🔊 重新朗读';
          replayBtn.style.cssText = 'margin-top:8px;font-size:12px;padding:2px 8px;opacity:0.7;';
          replayBtn.onclick = () => ttsReplayMessage(aiMsgDiv);
          aiMsgDiv.appendChild(replayBtn);

          // 更新消息 ID 为真实 ID
          aiMsgDiv.dataset.id = result.id;

          // 更新 app state
          AppState.messages.push({
            id: result.id,
            role: 'assistant',
            content: result.content,
            formatted: result.formatted,
            hidden: 0,
            created_at: new Date().toISOString(),
          });
          // 限制内存中消息数量，防止超长对话导致浏览器内存溢出
          const MAX_MEMORY_MSGS = 500;
          if (AppState.messages.length > MAX_MEMORY_MSGS) {
            AppState.messages = AppState.messages.slice(-MAX_MEMORY_MSGS);
          }

          // Update token stats from backend
          if (result.tokenStats) {
            setTokenStats(result.tokenStats);
          }

          // BGM check
          try { const f = typeof result.formatted === 'string' ? JSON.parse(result.formatted) : result.formatted; if (f && f.mood) playBGM(f.mood); } catch { }

          // 更新对话标题
          const conv = AppState.currentConversation;
          if (conv) {
            DOM.conversationTitle().textContent = conv.title || AppState.currentCharacter?.name || '对话';
          }

          isStreaming = false;
        },
        onError: (error) => {
          aiMsgDiv.innerHTML = `<div class="narration-text" style="color: #DC143C;">生成出错: ${escapeHtml(error)}</div>`;
          isStreaming = false;
        }
      }
    );
  } catch (err) {
    console.error('[SendMessage] 失败:', err);
    if (isStreaming) {
      aiMsgDiv.innerHTML = `<div class="narration-text" style="color: #DC143C;">发送失败: ${escapeHtml(err.message)}</div>`;
    }
  } finally {
    AppState.isGenerating = false;
    updateSendButton();
    scrollToBottom();
  }
}

/**
 * 处理 AI 回复：提取状态变量、图片
 * formatted 格式扩展：
 *   { text, action, emotion, internal, status: { key: value, ... }, image: "url" | "description" }
 */
function processAIResponse(response) {
  const formatted = response.formatted;
  if (!formatted || typeof formatted !== 'object') return;

  // 提取状态（从 formatted.status 对象）— 完全替换不累积，避免不同轮次属性名不一致导致重复
  if (formatted.status && typeof formatted.status === 'object' && Object.keys(formatted.status).length > 0) {
    const newStatus = {};
    Object.entries(formatted.status).forEach(([key, value]) => {
      if (key !== '姓名' && key !== 'name') newStatus[key] = String(value);
    });
    AppState.userStatus = newStatus;
    saveStatusToDisk();
    renderStatusBar();
  }

  // 提取 portrait（角色头像数据）
  if (formatted.portrait && formatted.portrait.name) {
    const charName = formatted.portrait.name;
    const existing = AppState.characterRoster[charName];
    // 名册已有真实头像（非pending/空，也非NPC占位） → 跳过生成
    const hasRealAvatar = existing && existing.avatar && existing.avatar !== 'pending' && existing.avatar !== '' && existing.avatar !== 'NPCF' && existing.avatar !== 'NPCM';
    if (hasRealAvatar) {
      console.log('[Portrait]', charName, '已有头像，跳过生成');
    } else {
      console.log('[Portrait] 角色登场:', charName, existing?.avatar ? '(头像生成中，继续轮询)' : '(新角色)');
      if (!existing) {
        AppState.characterRoster[charName] = { ...formatted.portrait, avatar: '' };
      }
      pollPortraitReady(charName);
    }
  }

  // 提取 cg（NSFW 场景）
  if (formatted.cg) {
    console.log('[CG] NSFW 场景:', formatted.cg.character);
    pollCGGallery();
  }

  // 后端通知：有图片正在生成中（由管家AI触发的portrait/CG）
  if (formatted.imagePending) {
    console.log('[Gallery] Image generation pending, starting gallery poll');
    startGalleryPoll();  }

  // 提取图片
  if (formatted.image) {
    AppState.galleryImages.push('/api/images/files/' + formatted.image);
    AppState.galleryIndex = AppState.galleryImages.length - 1;
    renderGallery();
  }

  // Token 统计 (from backend)
  if (response.tokenStats) {
    setTokenStats(response.tokenStats);
  }

          // MVU 世界状态：优先使用后端从原始主AI输出已应用好的 worldState（权威，避免管家剥离导致丢失）
          if (response.worldState && typeof response.worldState === 'object' && Object.keys(response.worldState).length >= 0) {
            AppState.worldState = response.worldState;
            renderWorldStatePanel();
          } else if (response.content) {
            // 兜底：后端未提供时，从 butler 输出内容里实时解析（管家已配置保留变量块）
            applyWorldStateFromMessage(response.content).catch(e => console.error('[WorldState]', e));
          }
}

/**
 * STscript 引擎用的生成函数（Phase 2）：与 sendMessage 共用 ChatAPI.stream 与渲染逻辑，
 * 自包含实现避免改动核心发送链路。返回 { id, content, formatted }。
 */
async function scriptGenerate(content, opts = {}) {
  if (!AppState.currentConversation) throw new Error('没有活跃的对话');
  if (AppState.isGenerating) throw new Error('已有生成进行中，请先停止');
  const conversationId = AppState.currentConversation.id;
  const providerId = opts.providerId || null;

  AppState.roundCounter++;
  const currentRound = AppState.roundCounter;

  const userMsg = {
    id: 'temp-' + Date.now(),
    role: 'user',
    content,
    formatted: {},
    hidden: 0,
    created_at: new Date().toISOString(),
  };
  AppState.messages.push(userMsg);
  DOM.messagesArea().appendChild(createMessageElement(userMsg, currentRound));
  scrollToBottom();

  const aiMsgId = 'stream-' + Date.now();
  const aiMsgDiv = document.createElement('div');
  aiMsgDiv.className = 'story-block assistant';
  aiMsgDiv.dataset.id = aiMsgId;
  aiMsgDiv.dataset.round = currentRound;
  aiMsgDiv.innerHTML = `
    <div class="narration-text ai-streaming">
      <div class="typing-indicator"><span></span><span></span><span></span></div>
    </div>
    <div class="ai-time"></div>
  `;
  DOM.messagesArea().appendChild(aiMsgDiv);
  scrollToBottom();

  let isStreaming = true;
  AppState.isGenerating = true;
  updateSendButton();

  return new Promise((resolve, reject) => {
    ChatAPI.stream(conversationId, content, providerId, {
      onUserMessage: () => {},
      onToken: () => {},
      onDone: (result) => {
        processAIResponse(result);
        if (result.formatted && typeof result.formatted === 'object') {
          aiMsgDiv.innerHTML = renderAIBlock(result.formatted, result.content, new Date().toISOString());
          appendDebugEntry(result.formatted, result.content, formatTime(new Date().toISOString()), result.butler);
        } else {
          aiMsgDiv.innerHTML = renderAIBlock(null, result.content, new Date().toISOString());
        }
        try {
          const fmt = typeof result.formatted === 'string' ? JSON.parse(result.formatted) : result.formatted;
          if (fmt && fmt.segments) {
            aiMsgDiv.dataset.ttsSegments = JSON.stringify(fmt.segments);
            ttsPlaySegments(fmt.segments, { msgDiv: aiMsgDiv });
          }
        } catch (e) { /* TTS not critical */ }
        const replayBtn = document.createElement('button');
        replayBtn.className = 'btn btn-sm tts-replay-btn';
        replayBtn.innerHTML = '🔊 重新朗读';
        replayBtn.style.cssText = 'margin-top:8px;font-size:12px;padding:2px 8px;opacity:0.7;';
        replayBtn.onclick = () => ttsReplayMessage(aiMsgDiv);
        aiMsgDiv.appendChild(replayBtn);
        aiMsgDiv.dataset.id = result.id;
        AppState.messages.push({
          id: result.id, role: 'assistant', content: result.content,
          formatted: result.formatted, hidden: 0, created_at: new Date().toISOString(),
        });
        const MAX_MEMORY_MSGS = 500;
        if (AppState.messages.length > MAX_MEMORY_MSGS) AppState.messages = AppState.messages.slice(-MAX_MEMORY_MSGS);
        if (result.tokenStats) setTokenStats(result.tokenStats);
        try { const f = typeof result.formatted === 'string' ? JSON.parse(result.formatted) : result.formatted; if (f && f.mood) playBGM(f.mood); } catch (e) {}
        const conv = AppState.currentConversation;
        if (conv) DOM.conversationTitle().textContent = conv.title || AppState.currentCharacter?.name || '对话';
        isStreaming = false;
        AppState.isGenerating = false;
        updateSendButton();
        scrollToBottom();
        resolve({ id: result.id, content: result.content, formatted: result.formatted });
      },
      onError: (error) => {
        aiMsgDiv.innerHTML = `<div class="narration-text" style="color: #DC143C;">生成出错: ${escapeHtml(error)}</div>`;
        isStreaming = false;
        AppState.isGenerating = false;
        updateSendButton();
        reject(new Error(error));
      },
    }).catch((err) => {
      if (isStreaming) aiMsgDiv.innerHTML = `<div class="narration-text" style="color: #DC143C;">发送失败: ${escapeHtml(err.message)}</div>`;
      isStreaming = false;
      AppState.isGenerating = false;
      updateSendButton();
      reject(err);
    });
  });
}

/**
 * 暴露给 STscript 引擎的桥接 API（Phase 2/3：LLM 与消息命令复用既有管线）。
 * 挂在 window.AppScript，stscript.js 通过 global.AppScript 调用。
 */
window.AppScript = {
  async gen(content, opts) {
    return scriptGenerate(content || '', opts || {});
  },
  getLastUserContent() {
    for (let i = AppState.messages.length - 1; i >= 0; i--) {
      if (AppState.messages[i].role === 'user') return AppState.messages[i].content;
    }
    return '';
  },
  getConversationId() { return AppState.currentConversation ? AppState.currentConversation.id : null; },
  getUserId() { return AppState.userProfile ? AppState.userProfile.id : null; },
  async addMessage({ role = 'user', content = '', hidden = 0 } = {}) {
    const conversationId = this.getConversationId();
    if (!conversationId) throw new Error('没有活跃的对话');
    const tmpId = 'temp-' + Date.now();
    const msg = { id: tmpId, role, content, formatted: {}, hidden: hidden ? 1 : 0, created_at: new Date().toISOString() };
    AppState.messages.push(msg);
    DOM.messagesArea().appendChild(createMessageElement(msg, AppState.roundCounter));
    scrollToBottom();
    const res = await MessageAPI.create({ conversation_id: conversationId, role, content, hidden: hidden ? 1 : 0 });
    msg.id = res.id;
    const el = DOM.messagesArea().querySelector(`[data-id="${tmpId}"]`);
    if (el) el.dataset.id = res.id;
    return { id: res.id };
  },
  async hideMessage(target, hidden) {
    const msg = resolveScriptMessage(target);
    if (!msg) throw new Error('未找到目标消息');
    await MessageAPI.batchHide([msg.id], !!hidden);
    msg.hidden = hidden ? 1 : 0;
    const el = DOM.messagesArea().querySelector(`[data-id="${msg.id}"]`);
    if (el) el.classList.toggle('is-hidden', !!hidden);
    return { id: msg.id, hidden: !!hidden };
  },
  async deleteMessage(target) {
    const msg = resolveScriptMessage(target);
    if (!msg) throw new Error('未找到目标消息');
    await MessageAPI.delete(msg.id);
    AppState.messages = AppState.messages.filter(m => m.id !== msg.id);
    const el = DOM.messagesArea().querySelector(`[data-id="${msg.id}"]`);
    if (el) el.remove();
    return { id: msg.id };
  },
  async cutFrom(index) {
    const msgs = AppState.messages;
    const start = (index || 0) - 1;
    if (start < 0 || start >= msgs.length) return { deleted: 0 };
    const toDelete = msgs.slice(start).map(m => m.id);
    await MessageAPI.batchDelete(toDelete);
    AppState.messages = msgs.slice(0, start);
    toDelete.forEach(id => {
      const el = DOM.messagesArea().querySelector(`[data-id="${id}"]`);
      if (el) el.remove();
    });
    return { deleted: toDelete.length };
  },
  listMessages() {
    return AppState.messages.map((m, i) => ({
      index: i + 1,
      id: m.id,
      role: m.role,
      hidden: !!m.hidden,
      content: (m.content || '').slice(0, 80),
    }));
  },
  abort() { return abortGeneration(); },

  // ===== STscript 提示词注入 / 作者备注 (Phase 4) =====
  async inject({ content, role, position, depth } = {}) {
    const conversationId = this.getConversationId();
    if (!conversationId) throw new Error('没有活跃的对话');
    if (!content || !content.trim()) throw new Error('注入内容为空');
    const res = await fetch('/api/conversations/' + conversationId + '/script-injects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: 'add', content, role, position, depth }),
    });
    if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || '注入失败'); }
    const data = await res.json();
    return data.inject;
  },
  async listInjects() {
    const conversationId = this.getConversationId();
    if (!conversationId) return [];
    const res = await fetch('/api/conversations/' + conversationId + '/script-injects');
    if (!res.ok) return [];
    const data = await res.json();
    return data.injects || [];
  },
  async flushInjects() {
    const conversationId = this.getConversationId();
    if (!conversationId) throw new Error('没有活跃的对话');
    const res = await fetch('/api/conversations/' + conversationId + '/script-injects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: 'flush' }),
    });
    if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || '清空失败'); }
    return true;
  },
  async setAuthorNote({ content, position, depth } = {}) {
    const conversationId = this.getConversationId();
    if (!conversationId) throw new Error('没有活跃的对话');
    const res = await fetch('/api/conversations/' + conversationId + '/script-injects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: 'setNote', content, position, depth }),
    });
    if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || '设置作者备注失败'); }
    const data = await res.json();
    return data.authorNote;
  },
  async getAuthorNote() {
    const conversationId = this.getConversationId();
    if (!conversationId) return null;
    const res = await fetch('/api/conversations/' + conversationId + '/script-injects');
    if (!res.ok) return null;
    const data = await res.json();
    return data.authorNote || null;
  },
  async setInjectState({ role, position, depth } = {}) {
    const conversationId = this.getConversationId();
    if (!conversationId) throw new Error('没有活跃的对话');
    const res = await fetch('/api/conversations/' + conversationId + '/script-injects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: 'setState', role, position, depth }),
    });
    if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || '设置状态失败'); }
    const data = await res.json();
    return data.state;
  },
  async getInjectState() {
    const conversationId = this.getConversationId();
    if (!conversationId) return {};
    const res = await fetch('/api/conversations/' + conversationId + '/script-injects');
    if (!res.ok) return {};
    const data = await res.json();
    return data.state || {};
  },

  // ===== STscript 世界书命令 (Phase 5) =====
  // 解析当前活跃角色 id（优先 currentCharacter，回退 currentConversation.character_id）
  getCharacterId() {
    if (AppState.currentCharacter && AppState.currentCharacter.id) return AppState.currentCharacter.id;
    if (AppState.currentConversation && AppState.currentConversation.character_id) return AppState.currentConversation.character_id;
    return null;
  },
  async getChatBook() {
    const cid = this.getCharacterId();
    if (!cid) throw new Error('没有活跃的角色');
    const res = await fetch('/api/characters/' + cid + '/book');
    if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || '读取世界书失败'); }
    return await res.json();
  },
  async findEntry(search, field = 'key') {
    const book = await this.getChatBook();
    const entries = Array.isArray(book.entries) ? book.entries : [];
    const q = (search || '').toLowerCase();
    if (!q) return [];
    const f = String(field || 'key').toLowerCase();
    return entries.filter(e => {
      let hay;
      if (f === 'key' || f === 'keys') hay = (e.keys || []).map(k => String(k).toLowerCase()).join(' ');
      else if (f === 'comment' || f === 'name') hay = (e.comment || '').toLowerCase();
      else if (f === 'content') hay = (e.content || '').toLowerCase();
      else if (f === 'id' || f === 'uid') return String(e.id) === q;
      else hay = ((e.comment || '') + ' ' + (e.keys || []).join(' ') + ' ' + (e.content || '')).toLowerCase();
      return hay.includes(q);
    }).map(e => ({ id: e.id, comment: e.comment || '', keys: e.keys || [] }));
  },
  async getEntryField(entryId, field) {
    const book = await this.getChatBook();
    const entries = Array.isArray(book.entries) ? book.entries : [];
    const id = Number(entryId);
    const entry = entries.find(e => (e.id !== undefined ? Number(e.id) : Number(e.uid)) === id);
    if (!entry) throw new Error('未找到世界书条目 #' + entryId);
    const f = String(field || 'content').toLowerCase();
    const readField = f === 'key' ? 'keys' : (f === 'keysecondary' ? 'secondary_keys' : f);
    const val = entry[readField];
    if (val === undefined || val === null) return '';
    if (Array.isArray(val)) return val.join(',');
    return val;
  },
  async setEntryField(entryId, field, value) {
    const cid = this.getCharacterId();
    if (!cid) throw new Error('没有活跃的角色');
    const body = {};
    body[field] = value;
    const res = await fetch('/api/characters/' + cid + '/book/entry/' + entryId, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || '更新条目失败'); }
    const data = await res.json();
    return data.entry;
  },
  async createEntry({ comment = '', keys = [], content = '', constant = false, selective = false, insertion_order = 100, position = 'before_char' } = {}) {
    const cid = this.getCharacterId();
    if (!cid) throw new Error('没有活跃的角色');
    const res = await fetch('/api/characters/' + cid + '/book/entry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        comment,
        keys: Array.isArray(keys) ? keys : (keys ? String(keys).split(',').map(s => s.trim()).filter(Boolean) : []),
        content,
        constant: !!constant,
        selective: !!selective,
        insertion_order: Number(insertion_order) || 100,
        position: position || 'before_char',
      }),
    });
    if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || '创建条目失败'); }
    const data = await res.json();
    return data.entry;
  },

  // ===== STscript 角色/扩展命令 (Phase 6) =====
  async getCharacter(field) {
    const cid = this.getCharacterId();
    if (!cid) throw new Error('没有活跃的角色');
    const res = await fetch('/api/characters/' + cid);
    if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || '读取角色失败'); }
    const data = await res.json();
    const val = data[field];
    if (val === undefined || val === null) return '';
    if (Array.isArray(val)) return val.join(',');
    return val;
  },
  async updateCharacter(field, value) {
    const cid = this.getCharacterId();
    if (!cid) throw new Error('没有活跃的角色');
    const body = {};
    body[field] = value;
    const res = await fetch('/api/characters/' + cid, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || '更新角色失败'); }
    return value;
  },
  async triggerImage(prompt) {
    if (typeof triggerImageGeneration === 'function') {
      await triggerImageGeneration(prompt);
      return prompt;
    }
    throw new Error('生图功能不可用');
  },

  // ===== MVU 世界状态 (Tier 3 闭环) =====
  /** 读取当前对话的世界状态模型 */
  async getWorldState() {
    if (!AppState.currentConversation) return {};
    const res = await fetch('/api/conversations/' + AppState.currentConversation.id + '/world-state');
    if (!res.ok) return {};
    const data = await res.json().catch(() => ({}));
    return data.world_state || {};
  },
  /** 持久化世界状态模型 */
  async saveWorldState(model) {
    if (!AppState.currentConversation) throw new Error('没有活跃的对话');
    const res = await fetch('/api/conversations/' + AppState.currentConversation.id + '/world-state', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ world_state: model || {} }),
    });
    if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || '保存世界状态失败'); }
    return model;
  },

  // ===== STscript 角色导航命令 (Phase 6 剩余) =====
  /** 列出所有角色（摘要：id/name/avatar），供 /go /random /char-delete 使用 */
  async listCharacters() {
    const chars = await CharacterAPI.list().catch(() => []);
    return (chars || []).map(c => ({ id: c.id, name: c.name || '', avatar: c.avatar || '' }));
  },

  /** 按 id 切换到指定角色聊天 */
  async switchToCharacter(characterId, opts = {}) {
    if (!characterId) throw new Error('缺少角色 id');
    await selectCharacter(characterId, opts);
    return characterId;
  },

  /** 随机切换到一个角色聊天 */
  async goRandomCharacter() {
    const chars = await this.listCharacters();
    if (!chars.length) throw new Error('没有可用角色');
    const pick = chars[Math.floor(Math.random() * chars.length)];
    await selectCharacter(pick.id, { collapseAfter: true });
    return pick.name;
  },

  /** 按名称删除角色：精确 → 前缀 → 子串 模糊匹配 */
  async deleteCharacterByName(name) {
    const q = (name || '').trim().toLowerCase();
    if (!q) throw new Error('/char-delete 需要 <名称>');
    const chars = await this.listCharacters();
    let target = chars.find(c => (c.name || '').toLowerCase() === q);
    if (!target) target = chars.find(c => (c.name || '').toLowerCase().startsWith(q));
    if (!target) target = chars.find(c => (c.name || '').toLowerCase().includes(q));
    if (!target) throw new Error('未找到角色: ' + name);
    await CharacterAPI.delete(target.id);
    // 刷新内存中的角色列表与 UI
    AppState.characters = await CharacterAPI.list().catch(() => []);
    renderCharacterList();
    renderStripAvatars();
    return target.name;
  },

  // ===== STscript UI 命令 (Phase 6 剩余) =====
  /** 切换聊天样式：bubble / flat / single，并持久化到 localStorage */
  setChatStyle(style) {
    const valid = ['bubble', 'flat', 'single'];
    const s = (style || '').toLowerCase();
    if (!valid.includes(s)) throw new Error('未知样式: ' + style + ' (支持 bubble/flat/single)');
    document.body.classList.remove('chat-style-bubble', 'chat-style-flat', 'chat-style-single');
    document.body.classList.add('chat-style-' + s);
    try { localStorage.setItem('script:chatStyle', s); } catch (e) {}
    return s;
  },

  /** 切换顶栏/侧栏/调试抽屉显隐。mode: on/off/hide/show，省略则反转当前状态 */
  togglePanels(mode) {
    const hide = mode
      ? /^(off|hide|0|false)$/i.test(mode)
      : !document.body.classList.contains('script-panels-hidden');
    document.body.classList.toggle('script-panels-hidden', hide);
    try { localStorage.setItem('script:panelsHidden', hide ? '1' : '0'); } catch (e) {}
    return hide ? 'hidden' : 'shown';
  },

  /** 设置聊天背景：none=清除, default=恢复主题, 否则当作图片 URL/本地路径 */
  setBackground(value) {
    const v = (value || '').trim();
    if (localStorage.getItem('script:bgLocked') === '1') {
      throw new Error('背景已锁定（/unlockbg 解除）');
    }
    applyChatBackground(v);
    try { localStorage.setItem('script:bg', v); } catch (e) {}
    return v || 'none';
  },

  lockBackground() {
    try { localStorage.setItem('script:bgLocked', '1'); } catch (e) {}
    return 'locked';
  },
  unlockBackground() {
    try { localStorage.setItem('script:bgLocked', '0'); } catch (e) {}
    return 'unlocked';
  },
  isBackgroundLocked() {
    return localStorage.getItem('script:bgLocked') === '1';
  },

  /** 联网搜索（免 key，走后端 /api/script/websearch） */
  async webSearch(query) {
    const q = (query || '').trim();
    if (!q) throw new Error('/websearch 需要 <查询>');
    const res = await fetch('/api/script/websearch?q=' + encodeURIComponent(q) + '&limit=5');
    if (!res.ok) throw new Error('搜索请求失败');
    return await res.json();
  },
};

/** 应用背景值到 body（供 setBackground 与 UI 态重放共用）。none/default 特殊处理。 */
function applyChatBackground(v) {
  if (!v || v === 'none') {
    document.body.style.backgroundImage = 'none';
  } else if (v === 'default') {
    document.body.style.backgroundImage = '';
  } else {
    const url = /^https?:\/\//i.test(v) || v.startsWith('data:')
      ? v
      : (v.startsWith('/') ? v : '/' + v.replace(/^\/+/, ''));
    document.body.style.backgroundImage = 'url("' + url + '")';
  }
}

/** 启动时重放脚本持久化的 UI 状态（聊天样式 / 面板显隐 / 背景） */
function replayScriptUIState() {
  try {
    const style = localStorage.getItem('script:chatStyle');
    if (style) {
      document.body.classList.remove('chat-style-bubble', 'chat-style-flat', 'chat-style-single');
      document.body.classList.add('chat-style-' + style);
    }
    if (localStorage.getItem('script:panelsHidden') === '1') {
      document.body.classList.add('script-panels-hidden');
    }
    const bg = localStorage.getItem('script:bg');
    if (bg && localStorage.getItem('script:bgLocked') !== '1') {
      applyChatBackground(bg);
    }
  } catch (e) { console.warn('[replayScriptUIState]', e && e.message); }
}

/** STscript 消息命令：将 target（序号/last/#-n/id）解析为内存中的消息对象 */
function resolveScriptMessage(target) {
  const msgs = AppState.messages;
  if (!msgs.length) return null;
  if (typeof target === 'number') return msgs[target - 1] || null;
  if (target === 'last' || target === '#-1') return msgs[msgs.length - 1];
  if (typeof target === 'string' && target.startsWith('#-')) {
    const n = parseInt(target.slice(2), 10);
    return msgs[msgs.length - n] || null;
  }
  if (typeof target === 'string' && /^\d+$/.test(target)) return msgs[parseInt(target, 10) - 1] || null;
  return msgs.find(m => m.id === target) || null;
}

/**
 * 触发图像生成
 */
async function triggerImageGeneration(prompt) {
  try {
    showToast('正在生成场景画片...', 'info', 5000);
    const result = await ImageAPI.generate({
      prompt,
      width: 512,
      height: 512,
      steps: 20
    });

    if (result.images && result.images.length > 0) {
      for (const imgUrl of result.images) {
        AppState.galleryImages.push(imgUrl);
      }
      AppState.galleryIndex = AppState.galleryImages.length - 1;
      renderGallery();
      showToast('场景画片已生成', 'success');
    } else {
      showToast('图像生成未返回图片', 'warning');
    }
  } catch (err) {
    console.error('[ImageGen] 生成失败:', err);
    showToast(`图像生成失败: ${err.message}`, 'error');
  }
}

// ============ 从消息历史提取画廊和状态 ============

function extractGalleryFromMessages(messages) {
  AppState.galleryImages = [];
  AppState.galleryIndex = 0;

  messages.forEach(msg => {
    let formatted = null;
    if (msg.formatted && typeof msg.formatted === 'object') {
      formatted = msg.formatted;
    } else {
      try {
        formatted = typeof msg.formatted === 'string' ? JSON.parse(msg.formatted) : null;
      } catch { /* ignore */ }
    }

    if (formatted && formatted.image) {
      AppState.galleryImages.push(formatted.image);
    }
  });

  if (AppState.galleryImages.length > 0) {
    AppState.galleryIndex = AppState.galleryImages.length - 1;
  }

  renderGallery();
}

function extractStatusFromMessages(messages) {
  // 从最近的消息中提取状态更新（遍历最新的消息）
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'assistant') continue;

    let formatted = null;
    try {
      formatted = typeof msg.formatted === 'string' ? JSON.parse(msg.formatted) : msg.formatted;
    } catch { continue; }

    if (formatted && formatted.status && typeof formatted.status === 'object') {
      Object.entries(formatted.status).forEach(([key, value]) => {
        AppState.userStatus[key] = String(value);
      });
      break; // 只取最近一次状态更新
    }
  }

  renderStatusBar();
}

// ============ 画廊 ============

function renderGallery() {
  const vp = DOM.galleryViewport();
  const empty = DOM.galleryEmpty();
  const counter = DOM.galleryCounter();
  const prev = DOM.btnPrevImage();
  const next = DOM.btnNextImage();

  const allCG = AppState.cgGallery || [];
  const normalImages = AppState.galleryImages;
  const hasContent = allCG.length > 0 || normalImages.length > 0;

  if (!hasContent) {
    if (empty) empty.classList.remove('hidden');
    // 必须把 viewport 清空：vn-shell 的旧画廊兜底会扫这个 DOM 取 CG，
    // 留着上一次渲染的 <img class="cg-image"> 就会把上一局的 CG 复活成背景
    if (vp) vp.innerHTML = '';
    counter.textContent = '0 / 0';
    prev.disabled = true; next.disabled = true;
    return;
  }

  if (empty) empty.classList.add('hidden');

  // Build CG section at top
  let html = '';
  if (allCG.length > 0) {
    allCG.forEach((cg, i) => {
      const imgUrl = '/api/saves/' + getCurrentSaveId() + '/images/' + cg.filename;
      const desc = cg.character + (' - NSFW场景');
      html += `
        <div class="cg-item" data-cg-index="${i}">
          <div class="cg-img-wrap">
            <img src="${escapeHtml(imgUrl)}" class="cg-image cg-clickable" alt="CG ${i + 1}" title="点击放大"
                 onerror="this.style.display='none';this.nextElementSibling.style.display='flex';this.nextElementSibling.textContent='图片生成中...'"
                 onload="this.style.display='block';this.nextElementSibling.style.display='none'">
            <div class="cg-placeholder" style="display:none;width:100%;height:120px;align-items:center;justify-content:center;color:var(--text-muted);font-size:12px;background:var(--bg-input);border-radius:8px;"></div>
            <button class="cg-refresh-btn" data-cg-index="${i}" title="重新生成">↻</button>
            <button class="cg-delete-btn" data-cg-index="${i}" title="删除">✕</button>
          </div>
          <div class="cg-desc">${escapeHtml(desc)}</div>
        </div>`;
    });
  }

  // Normal images below
  if (normalImages.length > 0) {
    const currentImg = document.getElementById('galleryImage');
    if (currentImg) {
      currentImg.src = normalImages[AppState.galleryIndex];
      currentImg.classList.remove('hidden');
      html += `<div class="gallery-normal-section"></div>`;
    }
  }

  vp.innerHTML = html;

  // CG click → lightbox
  vp.querySelectorAll('.cg-clickable').forEach(img => {
    img.addEventListener('click', (e) => {
      e.preventDefault();
      showAvatarLightbox(img.src);
    });
  });
  // CG refresh button
  vp.querySelectorAll('.cg-refresh-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const idx = parseInt(btn.dataset.cgIndex);
      const cg = allCG[idx];
      if (!cg || !cg.prompt) return;
      btn.textContent = '⟳';
      btn.disabled = true;
      try {
        const pollRetries = 30;
        await request('/images/regenerate', {
          method: 'POST',
          body: { prompt: cg.prompt, type: 'cg', character_name: cg.character, conversation_id: AppState.currentConversation?.id }
        });
        showToast('CG 重新生成已提交', 'success');
        pollCGGallery(pollRetries);
      } catch (err) {
        showToast('重新生成失败', 'error');
      }
      btn.textContent = '↻';
      btn.disabled = false;
    });
  });
  // CG delete button
  vp.querySelectorAll('.cg-delete-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault(); e.stopPropagation();
      if (!confirm('删除此CG？')) return;
      const idx = parseInt(btn.dataset.cgIndex);
      try {
        await request('/saves/' + getCurrentSaveId() + '/cg-gallery/' + idx, { method: 'DELETE' });
        AppState.cgGallery.splice(idx, 1);
        renderGallery();
        showToast('CG 已删除', 'success');
      } catch (err) { showToast('删除失败', 'error'); }
    });
  });

  if (normalImages.length > 0) {
    counter.textContent = `${AppState.galleryIndex + 1} / ${normalImages.length}`;
    prev.disabled = AppState.galleryIndex <= 0;
    next.disabled = AppState.galleryIndex >= normalImages.length - 1;
  } else {
    counter.textContent = '';
    prev.disabled = true; next.disabled = true;
  }
}

function navigateGallery(direction) {
  const newIndex = AppState.galleryIndex + direction;
  if (newIndex < 0 || newIndex >= AppState.galleryImages.length) return;
  AppState.galleryIndex = newIndex;
  renderGallery();
}

// ============ 手机弹出菜单（数据中心）============

function initDraggablePhoneBtn() {
  const btn = DOM.btnPhoneFloat();
  let isDragging = false;
  let startX, startY, startLeft, startTop;
  let hasMoved = false;

  // Persisted position (survives open/close/reload not — just session)
  window._phoneBtnPos = window._phoneBtnPos || null;
  if (window._phoneBtnPos) {
    btn.style.bottom = 'auto';
    btn.style.right = 'auto';
    btn.style.left = window._phoneBtnPos.left + 'px';
    btn.style.top = window._phoneBtnPos.top + 'px';
  }

  btn.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    isDragging = true;
    hasMoved = false;
    startX = e.clientX;
    startY = e.clientY;
    const rect = btn.getBoundingClientRect();
    startLeft = rect.left;
    startTop = rect.top;
    btn.classList.add('dragging');
    // Switch to positioning by left/top instead of bottom/right
    btn.style.bottom = 'auto';
    btn.style.right = 'auto';
    btn.style.left = startLeft + 'px';
    btn.style.top = startTop + 'px';
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) hasMoved = true;
    let newLeft = startLeft + dx;
    let newTop = startTop + dy;
    // Clamp to viewport
    const maxX = window.innerWidth - btn.offsetWidth;
    const maxY = window.innerHeight - btn.offsetHeight;
    newLeft = Math.max(0, Math.min(newLeft, maxX));
    newTop = Math.max(0, Math.min(newTop, maxY));
    btn.style.left = newLeft + 'px';
    btn.style.top = newTop + 'px';
  });

  document.addEventListener('mouseup', (e) => {
    if (!isDragging) return;
    isDragging = false;
    btn.classList.remove('dragging');
    const rect = btn.getBoundingClientRect();
    if (!hasMoved) {
      // Click — toggle popup, keep current position (don't reset!)
      togglePhonePopup();
    } else {
      // Drag — save position for persistence
      window._phoneBtnPos = { left: rect.left, top: rect.top };
      btn.style.left = rect.left + 'px';
      btn.style.top = rect.top + 'px';
      btn.style.bottom = 'auto';
      btn.style.right = 'auto';
    }
  });

  // Touch support
  btn.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    isDragging = true;
    hasMoved = false;
    const touch = e.touches[0];
    startX = touch.clientX;
    startY = touch.clientY;
    const rect = btn.getBoundingClientRect();
    startLeft = rect.left;
    startTop = rect.top;
    btn.classList.add('dragging');
    btn.style.bottom = 'auto';
    btn.style.right = 'auto';
    btn.style.left = startLeft + 'px';
    btn.style.top = startTop + 'px';
  }, { passive: false });

  document.addEventListener('touchmove', (e) => {
    if (!isDragging) return;
    const touch = e.touches[0];
    const dx = touch.clientX - startX;
    const dy = touch.clientY - startY;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) hasMoved = true;
    let newLeft = startLeft + dx;
    let newTop = startTop + dy;
    const maxX = window.innerWidth - btn.offsetWidth;
    const maxY = window.innerHeight - btn.offsetHeight;
    newLeft = Math.max(0, Math.min(newLeft, maxX));
    newTop = Math.max(0, Math.min(newTop, maxY));
    btn.style.left = newLeft + 'px';
    btn.style.top = newTop + 'px';
    e.preventDefault();
  }, { passive: false });

  document.addEventListener('touchend', () => {
    if (!isDragging) return;
    isDragging = false;
    btn.classList.remove('dragging');
    const rect = btn.getBoundingClientRect();
    if (!hasMoved) {
      togglePhonePopup();
    } else {
      window._phoneBtnPos = { left: rect.left, top: rect.top };
      btn.style.left = rect.left + 'px';
      btn.style.top = rect.top + 'px';
      btn.style.bottom = 'auto';
      btn.style.right = 'auto';
    }
  });

  // Phone popup header drag
  initPhonePopupDrag();
}

/* ── MVU 世界状态悬浮按钮（可拖动，点击切换右侧抽屉） ── */
function toggleWorldStateDrawer() {
  const d = document.getElementById('worldStateDrawer');
  if (!d) return;
  d.classList.toggle('hidden');
  if (!d.classList.contains('hidden')) {
    renderWorldStatePanel();
    positionWorldStateDrawer();
  }
  const btn = document.getElementById('btnWorldStateFloat');
  if (btn) btn.classList.toggle('active', !d.classList.contains('hidden'));
}

// Position the MVU drawer near its floating button (above it, like the data center popup)
function positionWorldStateDrawer() {
  const btn = document.getElementById('btnWorldStateFloat');
  const d = document.getElementById('worldStateDrawer');
  if (!btn || !d || d.classList.contains('hidden')) return;
  const rect = btn.getBoundingClientRect();
  const w = d.offsetWidth || 380;
  const h = d.offsetHeight || 504;
  let top = rect.top - h - 10;
  if (top < 10) top = rect.bottom + 10;
  top = Math.max(10, Math.min(top, window.innerHeight - h - 10));
  let left = rect.left + rect.width / 2 - w / 2;
  left = Math.max(10, Math.min(left, window.innerWidth - w - 10));
  d.style.right = 'auto';
  d.style.bottom = 'auto';
  d.style.left = left + 'px';
  d.style.top = top + 'px';
}

// Make the MVU drawer draggable by its header (excludes the close button)
function initWorldStateDrawerDrag() {
  const d = document.getElementById('worldStateDrawer');
  if (!d) return;
  const header = d.querySelector('.world-state-drawer-header');
  if (!header) return;
  let dragging = false, sx, sy, sl, st;
  const startDrag = (cx, cy) => {
    dragging = true; sx = cx; sy = cy;
    const r = d.getBoundingClientRect();
    sl = r.left; st = r.top;
    d.style.transition = 'none';
    d.style.right = 'auto'; d.style.bottom = 'auto';
    d.style.left = sl + 'px'; d.style.top = st + 'px';
  };
  const moveDrag = (cx, cy) => {
    if (!dragging) return;
    let nl = sl + (cx - sx);
    let nt = st + (cy - sy);
    nl = Math.max(10, Math.min(nl, window.innerWidth - d.offsetWidth - 10));
    nt = Math.max(10, Math.min(nt, window.innerHeight - d.offsetHeight - 10));
    d.style.left = nl + 'px';
    d.style.top = nt + 'px';
  };
  const endDrag = () => { if (dragging) { dragging = false; d.style.transition = ''; } };
  header.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('.modal-close')) return;
    startDrag(e.clientX, e.clientY);
    e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => moveDrag(e.clientX, e.clientY));
  document.addEventListener('mouseup', endDrag);
  header.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    if (e.target.closest('.modal-close')) return;
    startDrag(e.touches[0].clientX, e.touches[0].clientY);
  }, { passive: false });
  document.addEventListener('touchmove', (e) => {
    if (!dragging) return;
    moveDrag(e.touches[0].clientX, e.touches[0].clientY);
    e.preventDefault();
  }, { passive: false });
  document.addEventListener('touchend', endDrag);
}

function initDraggableWorldStateBtn() {
  const btn = document.getElementById('btnWorldStateFloat');
  if (!btn) return;
  let isDragging = false, startX, startY, startLeft, startTop, hasMoved = false;
  window._wsBtnPos = window._wsBtnPos || null;
  if (window._wsBtnPos) {
    btn.style.bottom = 'auto'; btn.style.right = 'auto';
    btn.style.left = window._wsBtnPos.left + 'px';
    btn.style.top = window._wsBtnPos.top + 'px';
  }
  const onDown = (cx, cy) => {
    isDragging = true; hasMoved = false; startX = cx; startY = cy;
    const rect = btn.getBoundingClientRect();
    startLeft = rect.left; startTop = rect.top;
    btn.classList.add('dragging');
    btn.style.bottom = 'auto'; btn.style.right = 'auto';
    btn.style.left = startLeft + 'px'; btn.style.top = startTop + 'px';
  };
  const onMove = (cx, cy) => {
    if (!isDragging) return;
    const dx = cx - startX, dy = cy - startY;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) hasMoved = true;
    let nl = startLeft + dx, nt = startTop + dy;
    const maxX = window.innerWidth - btn.offsetWidth, maxY = window.innerHeight - btn.offsetHeight;
    nl = Math.max(0, Math.min(nl, maxX));
    nt = Math.max(0, Math.min(nt, maxY));
    btn.style.left = nl + 'px'; btn.style.top = nt + 'px';
  };
  const onUp = () => {
    if (!isDragging) return;
    isDragging = false;
    btn.classList.remove('dragging');
    const rect = btn.getBoundingClientRect();
    if (!hasMoved) toggleWorldStateDrawer();
    else { window._wsBtnPos = { left: rect.left, top: rect.top }; }
  };
  btn.addEventListener('mousedown', (e) => { if (e.button !== 0) return; onDown(e.clientX, e.clientY); e.preventDefault(); });
  document.addEventListener('mousemove', (e) => onMove(e.clientX, e.clientY));
  document.addEventListener('mouseup', onUp);
  btn.addEventListener('touchstart', (e) => { if (e.touches.length !== 1) return; onDown(e.touches[0].clientX, e.touches[0].clientY); }, { passive: false });
  document.addEventListener('touchmove', (e) => { if (!isDragging) return; onMove(e.touches[0].clientX, e.touches[0].clientY); e.preventDefault(); }, { passive: false });
  document.addEventListener('touchend', onUp);
}

/** 根据当前角色是否为 engine / MVU 卡，显示/隐藏 MVU 悬浮按钮。 */
function updateWorldStateFloatVisibility() {
  const btn = document.getElementById('btnWorldStateFloat');
  if (!btn) return;
  const c = AppState.currentCharacter;
  const ui = getCharUIHintsFromState();
  const isEngine = !!(c && c.markup_mode === 'game-xml');
  const ws = AppState.worldState;
  const hasData = !!(ws && Object.keys(ws).length > 0);
  const show = !!c && (ui.hasMVU || isEngine || hasData);
  btn.classList.toggle('hidden', !show);
  const drawer = document.getElementById('worldStateDrawer');
  if (!show && drawer && !drawer.classList.contains('hidden')) {
    drawer.classList.add('hidden');
    btn.classList.remove('active');
  }
}

// Callback to update popup position relative to draggable button
function updatePhonePopupPosition() {
  const btn = DOM.btnPhoneFloat();
  const rect = btn.getBoundingClientRect();
  const popup = DOM.phonePopup();
  if (popup.classList.contains('hidden')) return;

  // Position popup above the button
  const popupHeight = 440;
  const popupWidth = 390;
  const top = rect.top - popupHeight - 10;
  if (top < 10) {
    // Popup would go off-screen above, position below
    popup.style.bottom = 'auto';
    popup.style.top = (rect.bottom + 10) + 'px';
  } else {
    popup.style.top = top + 'px';
    popup.style.bottom = 'auto';
  }

  // Center popup horizontally relative to button
  let left = rect.left + (rect.width / 2) - (popupWidth / 2);
  left = Math.max(10, Math.min(left, window.innerWidth - popupWidth - 10));
  popup.style.left = left + 'px';
  popup.style.right = 'auto';
}

// Reset float button to default position
function resetPhoneBtnPosition() {
  const btn = DOM.btnPhoneFloat();
  window._phoneBtnPos = null;
  btn.style.left = '';
  btn.style.top = '';
  btn.style.bottom = '24px';
  btn.style.right = '24px';

  // Reset phone popup to default position too
  const popup = DOM.phonePopup();
  popup.style.left = '';
  popup.style.top = '';
  popup.style.right = '24px';
  popup.style.bottom = '82px';

  // Also reset MVU world state float button
  const wsBtn = document.getElementById('btnWorldStateFloat');
  if (wsBtn) {
    window._wsBtnPos = null;
    wsBtn.style.left = '';
    wsBtn.style.top = '';
    wsBtn.style.bottom = '80px';
    wsBtn.style.right = '24px';
  }

  showToast('悬浮按钮已复位', 'success');
}

// Make phone popup draggable by its body (excludes interactive elements)
function initPhonePopupDrag() {
  const popup = DOM.phonePopup();
  const body = popup.querySelector('.phone-body');
  if (!body) return;
  let dragging = false, sx, sy, sl, st;

  // Interactive elements that should NOT trigger drag
  const INTERACTIVE = 'BUTTON,INPUT,TEXTAREA,SELECT,.rpg-tab-btn,.roster-card,.phone-gallery-item,.phone-page-inner,.phone-page';

  body.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest(INTERACTIVE)) return;
    dragging = true;
    sx = e.clientX; sy = e.clientY;
    const r = popup.getBoundingClientRect();
    sl = r.left; st = r.top;
    popup.style.transition = 'none';
    popup.style.right = 'auto'; popup.style.bottom = 'auto';
    popup.style.left = sl + 'px'; popup.style.top = st + 'px';
    body.style.cursor = 'grabbing';
    e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    let nl = sl + (e.clientX - sx);
    let nt = st + (e.clientY - sy);
    nl = Math.max(10, Math.min(nl, window.innerWidth - 400));
    nt = Math.max(10, Math.min(nt, window.innerHeight - 450));
    popup.style.left = nl + 'px';
    popup.style.top = nt + 'px';
  });
  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    body.style.cursor = '';
    popup.style.transition = '';
  });

  body.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    if (e.target.closest(INTERACTIVE)) return;
    dragging = true;
    const t = e.touches[0];
    sx = t.clientX; sy = t.clientY;
    const r = popup.getBoundingClientRect();
    sl = r.left; st = r.top;
    popup.style.transition = 'none';
    popup.style.right = 'auto'; popup.style.bottom = 'auto';
    popup.style.left = sl + 'px'; popup.style.top = st + 'px';
    e.preventDefault();
  }, { passive: false });
  document.addEventListener('touchmove', (e) => {
    if (!dragging) return;
    const t = e.touches[0];
    let nl = sl + (t.clientX - sx);
    let nt = st + (t.clientY - sy);
    nl = Math.max(10, Math.min(nl, window.innerWidth - 400));
    nt = Math.max(10, Math.min(nt, window.innerHeight - 450));
    popup.style.left = nl + 'px';
    popup.style.top = nt + 'px';
  });
  document.addEventListener('touchend', () => { dragging = false; });
}

let phoneStack = ['home']; // Navigation stack for phone subpages

function togglePhonePopup() {
  const popup = DOM.phonePopup();
  const isOpening = popup.classList.contains('hidden');
  if (isOpening) {
    // Show round count
    updatePhoneRound();
    // Refresh data
    navigatePhoneTo('status');
    popup.classList.remove('hidden');
    if (!popup.style.left && !popup.style.right) {
      popup.style.right = '24px';
      popup.style.bottom = '82px';
      popup.style.left = 'auto';
      popup.style.top = 'auto';
    }
  } else {
    popup.classList.add('hidden');
  }
}

function updatePhoneRound() {
  const convId = AppState.currentConversationId;
  if (convId) {
    ChatAPI.getMessages(convId).then(msgs => {
      const userMsgs = msgs.filter(m => m.role === 'user');
      DOM.phoneTime().textContent = '第 ' + (userMsgs.length || 0) + ' 轮';
    }).catch(() => {
      DOM.phoneTime().textContent = '轮次 ?';
    });
  } else {
    DOM.phoneTime().textContent = '轮次 ?';
  }
}

function setActiveTab(tab) {
  document.querySelectorAll('.rpg-tab-btn').forEach(b => b.classList.remove('active'));
  const btn = document.querySelector('.rpg-tab-btn[data-tab="' + tab + '"]');
  if (btn) btn.classList.add('active');
}

function navigatePhoneTo(page) {
  document.querySelectorAll('.phone-page').forEach(p => p.classList.add('hidden'));
  const pageMap = {
    roster: DOM.phoneRosterPage,
    status: DOM.phoneStatusPage,
    memory: DOM.phoneMemoryPage,
    gallery: DOM.phoneGalleryPage,
    charDetail: DOM.phoneCharDetailPage,
  };
  const target = pageMap[page];
  if (target) target().classList.remove('hidden');

  // Refresh tab active state
  const tabMap = { roster: 'roster', status: 'status', memory: 'memory', gallery: 'gallery' };
  const tab = tabMap[page];
  if (tab) setActiveTab(tab);

  // Refresh data for the target page
  if (page === 'roster') loadRosterPage();
  else if (page === 'status') loadStatusPage();
  else if (page === 'memory') loadMemoryPage();
  else if (page === 'gallery') loadGalleryPage();
}

function phoneGoBack() {
  phoneStack.pop(); // Remove current
  const prev = phoneStack.pop() || 'home';
  navigatePhoneTo(prev);
}

function openPhoneApp(app) {
  navigatePhoneTo(app);
}

// Point global phoneGoBack for inline onclick
window.phoneGoBack = phoneGoBack;
window.openPhoneApp = openPhoneApp;

// ============ 角色名册 ============

// Parse roster Chinese fields → display fields
// 种族性别 format: "race_gender" e.g. "human_girl", "elf_male"
const RACE_CN = {
  human: '人类', elf: '精灵', demon: '恶魔', beast: '兽人', dwarf: '矮人', orc: '兽人',
  angel: '天使', dragon: '龙族', undead: '亡灵', fairy: '妖精', vampire: '吸血鬼', slime: '史莱姆',
  robot: '机器人', neko: '猫娘', kitsune: '狐妖', succubus: '魅魔', unknown: '未知'
};
const GENDER_CN = { girl: '女', female: '女', male: '男', boy: '男', futa: '扶她', other: '其他' };
// Danbooru tag -> Chinese translation for portrait field fallback
const TAG_CN = {
  // Hair color
  black_hair: '黑', brown_hair: '棕', blonde_hair: '金', white_hair: '白', red_hair: '红', blue_hair: '蓝',
  pink_hair: '粉', purple_hair: '紫', green_hair: '绿', silver_hair: '银', gray_hair: '灰', orange_hair: '橙',
  auburn_hair: '赤褐', light_brown_hair: '浅棕', dark_brown_hair: '深棕', platinum_blonde_hair: '铂金',
  // Hair style
  long_hair: '长发', short_hair: '短发', medium_hair: '中发', ponytail: '马尾', twintails: '双马尾',
  bob_cut: '波波头', bangs: '刘海', side_ponytail: '侧马尾', ahoge: '呆毛', hair_bun: '丸子头',
  braided_hair: '编发', messy_hair: '乱发', straight_hair: '直发', curly_hair: '卷发', wavy_hair: '波浪',
  // Eye color
  blue_eyes: '蓝', brown_eyes: '棕', green_eyes: '绿', red_eyes: '红', purple_eyes: '紫', gold_eyes: '金',
  amber_eyes: '琥珀', gray_eyes: '灰', pink_eyes: '粉', heterochromia: '异色瞳', silver_eyes: '银',
  // Body type
  petite: '娇小', tall: '高挑', muscular: '健壮', slim: '苗条', curvy: '丰满', athletic: '运动型',
  loli: '萝莉体型', milf: '成熟', chubby: '微胖', flat_chest: '平胸', large_breasts: '巨乳',
  // Age
  '1year_old': '1岁', '2year_old': '2岁', '3year_old': '3岁', '4year_old': '4岁', '5year_old': '5岁',
  '6year_old': '6岁', '7year_old': '7岁', '8year_old': '8岁', '9year_old': '9岁',
  '10year_old': '10岁', '11year_old': '11岁', '12year_old': '12岁', '13year_old': '13岁',
  '14year_old': '14岁', '15year_old': '15岁', '16year_old': '16岁', '17year_old': '17岁',
  '18year_old': '18岁', '19year_old': '19岁', '20year_old': '20岁', '21year_old': '21岁',
  '22year_old': '22岁', '23year_old': '23岁', '24year_old': '24岁', '25year_old': '25岁',
  '26year_old': '26岁', '27year_old': '27岁', '28year_old': '28岁', '29year_old': '29岁',
  '30year_old': '30岁', '35year_old': '35岁', '40year_old': '40岁', '45year_old': '45岁', '50year_old': '50岁',
  // Skin
  pale: '苍白', tan: '古铜', dark_skin: '深色', fair_skin: '白皙', olive_skin: '橄榄',
};
const cnTag = (tag) => TAG_CN[tag?.toLowerCase()] || tag || '';

function parseRosterFields(char) {
  const rg = char['种族性别'] || '';
  let race = '', gender = '';
  if (rg) {
    const parts = rg.split('_');
    if (parts.length >= 2) {
      race = RACE_CN[parts[0].toLowerCase()] || parts[0];
      gender = GENDER_CN[parts[1].toLowerCase()] || parts[1];
    } else {
      race = rg;
    }
  }
  // Intro from 简要介绍/简介/description or construct from available fields
  let intro = char['简要介绍'] || char['简介'] || char.description || char.intro || '';
  if (!intro) {
    // Construct fallback from portrait fields, translating danbooru tags to Chinese
    const parts = [];
    const ageVal = char['年龄'] || '';
    if (ageVal) parts.push(cnTag(ageVal) || ageVal);
    const hairColor = char['发色'] || '';
    const hairStyle = char['发型'] || '';
    if (hairColor && hairStyle) parts.push((cnTag(hairColor) || hairColor) + (cnTag(hairStyle) || hairStyle) + '发');
    else if (hairColor) parts.push((cnTag(hairColor) || hairColor) + '发');
    else if (hairStyle) parts.push(cnTag(hairStyle) || hairStyle);
    const eyeColor = char['瞳色'] || '';
    if (eyeColor) parts.push((cnTag(eyeColor) || eyeColor) + '瞳');
    const bodyType = char['身材'] || '';
    if (bodyType) parts.push(cnTag(bodyType) || bodyType);
    if (char['身高']) parts.push(char['身高'] + 'cm');
    intro = parts.join(' · ') || '';
  }
  return { race, gender, intro };
}

async function loadRosterPage() {
  const list = DOM.rosterList();
  const saveId = getCurrentSaveId();
  if (!saveId) {
    list.innerHTML = '<div class="phone-empty">未找到当前存档</div>';
    return;
  }
  try {
    const resp = await request('/saves/' + saveId + '/roster');
    const roster = resp.roster || {};
    const entries = Object.entries(roster);
    if (entries.length === 0) {
      list.innerHTML = '<div class="phone-empty">暂无角色记录</div>';
      return;
    }
    let html = '';
    for (const [name, char] of entries) {
      // Only show characters that have a real avatar (.jpg)
      if (!char.avatar || !char.avatar.endsWith('.jpg')) continue;
      const info = parseRosterFields(char);
      const avatarHtml = char.avatar
        ? `<img class="roster-card-avatar" src="/api/saves/${saveId}/images/${encodeURIComponent(char.avatar)}" alt="${escapeHtml(name)}" onclick="event.stopPropagation();viewFullSizeAvatar(this.src,'${escapeJs(name)}')">`
        : `<div class="roster-card-avatar-placeholder">👤</div>`;
      html += `<div class="roster-card" data-name="${escapeHtml(name)}" onclick="viewRosterChar('${escapeJs(name)}')">
        ${avatarHtml}
        <div class="roster-card-info">
          <div class="roster-card-name">${escapeHtml(name)}</div>
          <div class="roster-card-meta">${escapeHtml(info.race)} · ${escapeHtml(info.gender)}</div>
          <div class="roster-card-intro">${escapeHtml((info.intro || '').substring(0, 50))}</div>
        </div>
      </div>`;
    }
    list.innerHTML = html;
  } catch (err) {
    list.innerHTML = '<div class="phone-empty">加载失败: ' + escapeHtml(err.message) + '</div>';
  }
}
window.loadRosterPage = loadRosterPage;

function escapeJs(str) {
  return String(str).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"');
}

function viewFullSizeAvatar(src, name) {
  const overlay = document.createElement('div');
  overlay.className = 'phone-cg-full';
  overlay.innerHTML = `<img src="${src}" alt="${escapeHtml(name)}">`;
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay || e.target.tagName === 'IMG') overlay.remove();
  });
  document.body.appendChild(overlay);
}
window.viewFullSizeAvatar = viewFullSizeAvatar;

async function viewRosterChar(name) {
  const saveId = getCurrentSaveId();
  if (!saveId) return;
  try {
    const resp = await request('/saves/' + saveId + '/roster');
    const char = (resp.roster || {})[name];
    if (!char) return;

    const content = DOM.charDetailContent();
    const info = parseRosterFields(char);
    const avatarHtml = char.avatar
      ? `<img class="char-detail-avatar" src="/api/saves/${saveId}/images/${encodeURIComponent(char.avatar)}" alt="${escapeHtml(name)}" onclick="event.stopPropagation();viewFullSizeAvatar(this.src,'${escapeJs(name)}')">`
      : `<div class="char-detail-avatar-placeholder">👤</div>`;

    content.innerHTML = `
      <div class="char-detail-header">
        ${avatarHtml}
        <div class="char-detail-name">${escapeHtml(name)}</div>
        <div class="char-detail-meta">${escapeHtml(info.race)} · ${escapeHtml(info.gender)}</div>
        <div class="char-detail-intro">${escapeHtml(info.intro || '暂无介绍')}</div>
      </div>
      <div class="char-detail-actions">
        <button class="char-detail-btn" id="btnEditRosterChar" onclick="editRosterChar('${escapeJs(name)}')">✏️ 编辑</button>
        <button class="char-detail-btn danger" id="btnDeleteRosterChar" onclick="deleteRosterChar('${escapeJs(name)}')">🗑️ 删除</button>
      </div>
    `;
    navigatePhoneTo('charDetail');
  } catch { }
}
window.viewRosterChar = viewRosterChar;

function editRosterChar(name) {
  const saveId = getCurrentSaveId();
  if (!saveId) return;
  request('/saves/' + saveId + '/roster').then(resp => {
    const char = (resp.roster || {})[name] || {};
    const info = parseRosterFields(char);
    const content = DOM.charDetailContent();
    content.innerHTML = `
      <div class="char-edit-form">
        <div class="char-edit-field"><label>姓名</label><input id="editCharName" value="${escapeHtml(name)}" readonly style="opacity:0.6"></div>
        <div class="char-edit-field"><label>种族</label><input id="editCharRace" value="${escapeHtml(info.race)}"></div>
        <div class="char-edit-field"><label>性别</label><input id="editCharGender" value="${escapeHtml(info.gender)}"></div>
        <div class="char-edit-field"><label>简介</label><textarea id="editCharIntro" rows="3">${escapeHtml(info.intro)}</textarea></div>
        <div style="display:flex;gap:8px;margin-top:8px;justify-content:flex-end">
          <button class="char-detail-btn" onclick="saveRosterCharEdit('${escapeJs(name)}')">保存</button>
          <button class="char-detail-btn" onclick="viewRosterChar('${escapeJs(name)}')">取消</button>
        </div>
      </div>`;
  });
}
window.editRosterChar = editRosterChar;

function saveRosterCharEdit(name) {
  const saveId = getCurrentSaveId();
  if (!saveId) return;
  const race = document.getElementById('editCharRace')?.value || '';
  const gender = document.getElementById('editCharGender')?.value || '';
  const intro = document.getElementById('editCharIntro')?.value || '';
  // Build 种族性别 from race+gender
  const raceEn = Object.entries(RACE_CN).find(([, v]) => v === race)?.[0] || race.toLowerCase();
  const genderEn = Object.entries(GENDER_CN).find(([, v]) => v === gender)?.[0] || gender.toLowerCase();
  const updates = {
    '种族性别': raceEn + '_' + genderEn,
    '简要介绍': intro,
  };
  request('/saves/' + saveId + '/roster/' + encodeURIComponent(name), {
    method: 'PUT', body: updates,
  }).then(() => {
    showToast('角色已更新', 'success');
    viewRosterChar(name);
    loadRosterPage();
  });
}
window.saveRosterCharEdit = saveRosterCharEdit;

function deleteRosterChar(name) {
  if (!confirm(`确定从名册中删除「${name}」吗？此操作不可恢复。`)) return;
  const saveId = getCurrentSaveId();
  if (!saveId) return;
  request('/saves/' + saveId + '/roster/' + encodeURIComponent(name), { method: 'DELETE' }).then(() => {
    showToast('角色已删除', 'success');
    navigatePhoneTo('roster');
    loadRosterPage();
  });
}
window.deleteRosterChar = deleteRosterChar;

// ============ 主要状态 ============

async function loadStatusPage() {
  const saveId = getCurrentSaveId();
  if (saveId) {
    try {
      const resp = await request('/saves/' + saveId + '/status');
      if (resp && Object.keys(resp).length > 0) {
        AppState.userStatus = resp;
      }
    } catch { }
  }
  renderStatusBar();
}

async function saveStatusToDisk() {
  const saveId = getCurrentSaveId();
  if (!saveId) return;
  try {
    await request('/saves/' + saveId + '/status', {
      method: 'PUT', body: AppState.userStatus,
    });
  } catch { }
}

// saveStatusToDisk is now called directly from processAIResponse when status is updated

// ============ 记忆表格 ============

async function loadMemoryPage() {
  const list = DOM.memoryList();
  const saveId = getCurrentSaveId();
  if (!saveId) {
    list.innerHTML = '<div class="phone-empty">未找到当前存档</div>';
    return;
  }
  try {
    const resp = await request('/saves/' + saveId + '/memory');
    const memory = resp.memory || [];
    // Handle both array and object formats
    const entries = Array.isArray(memory)
      ? memory
      : Object.entries(memory).map(([key, value]) => ({ key, value }));
    if (entries.length === 0) {
      list.innerHTML = '<div class="phone-empty">暂无记忆数据</div>';
      return;
    }
    let html = '';
    let idx = 0;
    for (const entry of entries) {
      const key = entry.key || entry.topic || entry.name || '';
      let value = entry.value || entry.content || entry.summary || '';
      const fullValue = value;
      // Strip HTML/Markdown formatting for clean display
      value = String(value).replace(/<[^>]*>/g, '').replace(/[*_]{1,2}/g, '');
      if (value.length > 200) value = value.substring(0, 200) + '...';
      html += `<div class="roster-card memory-card" onclick="openMemoryEdit(${idx},'${escapeJs(key)}')" style="cursor:pointer">
          <div class="roster-card-info">
            <div class="roster-card-name">${escapeHtml(key)}</div>
            <div class="roster-card-intro" style="white-space:pre-wrap;line-height:1.3">${escapeHtml(value)}</div>
          </div>
        </div>`;
      idx++;
    }
    list.innerHTML = html;
    // Store entries for editing
    window._memoryEntries = entries;
  } catch (err) {
    list.innerHTML = '<div class="phone-empty">加载失败: ' + escapeHtml(err.message) + '</div>';
  }
}

function openMemoryEdit(idx, key) {
  const entries = window._memoryEntries || [];
  const entry = entries[idx];
  if (!entry) return;
  const value = entry.value || entry.content || entry.summary || '';
  document.getElementById('memoryEditKey').textContent = key || '编辑';
  document.getElementById('memoryEditValue').value = String(value).replace(/<[^>]*>/g, '');
  document.getElementById('memoryEditOverlay').classList.remove('hidden');
  document.getElementById('memoryEditOverlay')._editIdx = idx;
  document.getElementById('memoryEditOverlay')._editKey = key;
}

function closeMemoryEdit() {
  document.getElementById('memoryEditOverlay').classList.add('hidden');
}

async function saveMemoryEdit() {
  const saveId = getCurrentSaveId();
  if (!saveId) return;
  const newValue = document.getElementById('memoryEditValue').value;
  const overlay = document.getElementById('memoryEditOverlay');
  const idx = overlay._editIdx;
  const key = overlay._editKey;
  try {
    // Update local entries
    const entries = window._memoryEntries || [];
    if (entries[idx]) {
      entries[idx].value = newValue;
      entries[idx].content = newValue;
    }
    // Write back to event_log.md via API
    await request('/saves/' + saveId + '/memory/edit', {
      method: 'PUT', body: { key, value: newValue, index: idx }
    });
    closeMemoryEdit();
    loadMemoryPage(); // refresh display
    showToast('记忆已保存', 'success');
  } catch (err) {
    showToast('保存失败: ' + err.message, 'error');
  }
}
window.openMemoryEdit = openMemoryEdit;
window.closeMemoryEdit = closeMemoryEdit;
window.saveMemoryEdit = saveMemoryEdit;
window.loadMemoryPage = loadMemoryPage;

// ============ CG画廊 ============
let _galleryItems = []; // store for arrow navigation

async function loadGalleryPage() {
  const grid = DOM.phoneGalleryGrid();
  const saveId = getCurrentSaveId();
  if (!saveId) {
    grid.innerHTML = '<div class="phone-empty">未找到当前存档</div>';
    return;
  }
  try {
    const resp = await request('/saves/' + saveId + '/cg-gallery');
    const gallery = resp.gallery || [];
    _galleryItems = gallery.map(cg => ({
      url: `/api/saves/${saveId}/images/${encodeURIComponent(cg.filename)}`,
      label: cg.character || ''
    }));
    if (_galleryItems.length === 0) {
      grid.innerHTML = '<div class="phone-empty">暂无CG图片</div>';
      return;
    }
    let html = '';
    _galleryItems.forEach((item, idx) => {
      html += `<div class="phone-gallery-item" onclick="viewFullCG(${idx})">
        <img src="${item.url}" loading="lazy" alt="${escapeHtml(item.label)}">
        <div class="phone-gallery-label">${escapeHtml(item.label)}</div>
      </div>`;
    });
    grid.innerHTML = html;
  } catch (err) {
    grid.innerHTML = '<div class="phone-empty">加载失败: ' + escapeHtml(err.message) + '</div>';
  }
}
window.loadGalleryPage = loadGalleryPage;

function viewFullCG(idx) {
  const overlay = document.createElement('div');
  overlay.className = 'phone-cg-full';

  function show(i) {
    if (i < 0) i = _galleryItems.length - 1;
    if (i >= _galleryItems.length) i = 0;
    overlay._cgIndex = i;
    const item = _galleryItems[i];
    overlay.innerHTML = `<img src="${item.url}" alt="${escapeHtml(item.label)}">`;
    const prev = document.createElement('button');
    prev.className = 'cg-nav-btn cg-prev';
    prev.innerHTML = '‹';
    prev.onclick = (e) => { e.stopPropagation(); show(overlay._cgIndex - 1); };
    const next = document.createElement('button');
    next.className = 'cg-nav-btn cg-next';
    next.innerHTML = '›';
    next.onclick = (e) => { e.stopPropagation(); show(overlay._cgIndex + 1); };
    overlay.appendChild(prev);
    overlay.appendChild(next);
  }

  show(idx);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });
  document.body.appendChild(overlay);
}
window.viewFullCG = viewFullCG;

// ============ 状态栏渲染（保留原有逻辑，在手机内显示）============

function renderStatusBar() {
  const container = DOM.statusPopupBody();
  const status = AppState.userStatus;
  const userName = (AppState.userProfile && AppState.userProfile.name) || '我';

  const hasStatus = status && Object.keys(status).length > 0;

  if (!hasStatus) {
    container.innerHTML = '<div class="status-empty">暂无状态数据</div>';
    return;
  }

  const entries = Object.entries(status).filter(([k]) => k !== '姓名' && k !== 'name');

  // Icon mapping for common status keys
  const keyIcons = {
    // HP/combat
    'hp': '❤', 'HP': '❤', '生命': '❤', '生命值': '❤', '体力': '❤',
    'mp': '◆', 'MP': '◆', '魔力': '◆', '魔力值': '◆', '精神': '◆',
    'xp': '?', 'exp': '?', 'EXP': '?', '经验': '?', '经验值': '?',
    // Attributes
    '力量': '?', 'STR': '?', '攻击': '?', '攻击力': '?', '强度': '?',
    '防御': '?', '防御力': '?',
    '敏捷': '?', 'DEX': '?', '速度': '?',
    '智力': '?', 'INT': '?', '智慧': '?',
    '体质': '?', 'CON': '?', '耐力': '?',
    '魅力': '?', 'CHA': '?',
    '感知': '?', 'WIS': '?',
    '幸运': '?', '运气': '?',
    // Economy
    '金币': '?', '金钱': '?', '货币': '?', '银币': '?', '资产': '?',
    // Meta
    '等级': '?', 'LV': '?',
    '种族': '?', '性别': '?',
    '位置': '?', '地点': '?', '时间': '?',
    '装备': '?', '物品': '?', '持有物': '?',
    '技能': '?',
    '状态': '?', '危机': '?',
    '声望': '?',
    '舰船': '?',
    '饥饿': '?', '镇静': '?',
    '生育率': '?', 'FERT': '?',
    // Compound
    '旅店房间数': '?', '员工数量': '?', '房客数量': '?',
    '已攻略数量': '?', '已攻略名册': '?',
  };

  let html = '';
  // Name row
  html += `<div class="stats-name-row"><span class="stat-name">👤 姓名</span><span class="stat-value">${escapeHtml(userName)}</span></div>`;

  // Stat grid
  html += '<div class="stats-grid">';
  for (const [key, value] of entries) {
    const label = getStatusLabel(key);
    const icon = getStatusIcon(key, label);
    const display = formatStatusValue(value);
    const displayText = String(display).replace(/<[^>]*>/g, '');
    html += `<div class="stat-item">
      <span class="stat-name">${icon} ${escapeHtml(label)}</span>
      <span class="stat-value">${escapeHtml(displayText)}</span>
    </div>`;
  }
  html += '</div>';
  container.innerHTML = html;
}

/**
 * 状态键名美化：通用处理，不硬编码任何特定卡片的属性名
 * 只做emoji前缀去除 + 首字母大写美化
 */
function getStatusLabel(key) {
  if (!key) return '';
  let label = key.replace(/^[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{2300}-\u{23FF}\u{2B50}\u{FE00}-\u{FE0F}\u{200D}\s]+/u, '').trim();
  return label || key;
}

function getStatusIcon(key, label) {
  const k = (key || '').toLowerCase();
  const l = (label || '').toLowerCase();
  // Simple single-char icons using widely-supported Unicode
  if (k === 'hp' || l.includes('生命') || l.includes('体力')) return '\u2665'; // ♥
  if (k === 'mp' || l.includes('魔力') || l.includes('精神')) return '\u2666'; // ♦
  if (k === 'str' || l.includes('力量') || l.includes('攻击') || l.includes('强度')) return '\u2020'; // †
  if (l.includes('防御')) return '\u25C8'; // ◈
  if (k === 'dex' || l.includes('敏捷') || l.includes('速度')) return '\u21BB'; // ↻
  if (k === 'int' || l.includes('智力') || l.includes('智慧')) return '\u2605'; // ★
  if (k === 'con' || l.includes('体质') || l.includes('耐力')) return '\u2022'; // •
  if (k === 'cha' || l.includes('魅力')) return '\u2661'; // ♡
  if (k === 'wis' || l.includes('感知')) return '\u263C'; // ☼
  if (l.includes('幸运') || l.includes('运气')) return '\u2663'; // ♣
  if (l.includes('金币') || l.includes('金钱') || l.includes('货币') || l.includes('银币') || l.includes('资产')) return '\u25CB'; // ○
  if (l.includes('经验') || l.includes('等级') || k === 'lv') return '\u2191'; // ↑
  if (l.includes('位置') || l.includes('地点')) return '\u25C7'; // ◇
  if (l.includes('时间')) return '\u25F3'; // ◳
  if (l.includes('装备') || l.includes('物品') || l.includes('持有')) return '\u2726'; // ✦
  if (l.includes('技能')) return '\u25B3'; // △
  if (l.includes('状态') || l.includes('危机')) return '\u26A0'; // ⚠
  if (l.includes('声望')) return '\u2606'; // ☆
  if (l.includes('舰船')) return '\u2197'; // ↗
  if (l.includes('种族')) return '\u263A'; // ☺
  if (l.includes('性别')) return '\u26A6'; // ⚦
  if (l.includes('饥饿')) return '\u25AC'; // ▬
  if (l.includes('镇静')) return '\u25D8'; // ◘
  if (l.includes('生育') || k === 'fert') return '\u2696'; // ⚖
  if (l.includes('房间') || l.includes('旅店')) return '\u2302'; // ⌂
  if (l.includes('员工')) return '\u263A'; // ☺
  if (l.includes('房客')) return '\u263B'; // ☻
  if (l.includes('攻略')) return '\u2665'; // ♥
  return '\u25CF'; // ●
}

/**
 * 状态值格式化：X/Y 格式渲染为进度条，百分比渲染为进度条，其他直接显示
 */
function formatStatusValue(value) {
  const str = String(value);
  const fracMatch = str.match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/);
  if (fracMatch) {
    const cur = parseFloat(fracMatch[1]);
    const max = parseFloat(fracMatch[2]);
    const pct = max > 0 ? Math.min(100, Math.round(cur / max * 100)) : 0;
    return `<div class="status-bar-wrap"><div class="status-bar-fill ${getBarClass(pct)}" style="width:${pct}%"></div><span class="status-bar-text">${str}</span></div>`;
  }
  const pctMatch = str.match(/^(\d+(?:\.\d+)?)\s*%$/);
  if (pctMatch) {
    const pct = Math.min(100, Math.round(parseFloat(pctMatch[1])));
    return `<div class="status-bar-wrap"><div class="status-bar-fill ${getBarClass(pct)}" style="width:${pct}%"></div><span class="status-bar-text">${str}</span></div>`;
  }
  return escapeHtml(str);
}

function getBarClass(pctOrKey) {
  if (typeof pctOrKey === 'number') {
    if (pctOrKey >= 60) return 'bar-high';
    if (pctOrKey >= 30) return 'bar-mid';
    return 'bar-low';
  }
  return 'bar-high';
}


// ============ 调试面板 ============

function appendDebugEntry(formatted, rawContent, timeStr, butlerResult) {
  AppState.debugRoundCounter++;
  const roundNum = AppState.debugRoundCounter;
  const MAX_DEBUG_ENTRIES = 50; // 限制调试条目数量，防止DOM累积导致浏览器卡死

  // 主Agent面板
  const mainContainer = DOM.debugMainAgentContent();
  const mainEmpty = mainContainer.querySelector('.debug-empty');
  if (mainEmpty) mainEmpty.remove();
  const mainHtml = renderMainAgentDebugEntry(formatted, rawContent, timeStr, roundNum);
  mainContainer.insertAdjacentHTML('beforeend', mainHtml);
  // 移除旧条目，保持DOM树在可控范围内
  const mainCards = mainContainer.querySelectorAll('.debug-card');
  while (mainCards.length > MAX_DEBUG_ENTRIES) {
    mainCards[0].remove();
  }
  requestAnimationFrame(() => { mainContainer.scrollTop = mainContainer.scrollHeight; });

  // 管家AI面板
  if (butlerResult) {
    const butlerContainer = DOM.debugButlerContent();
    const butlerEmpty = butlerContainer.querySelector('.debug-empty');
    if (butlerEmpty) butlerEmpty.remove();
    const butlerHtml = renderButlerDebugEntry(butlerResult, timeStr, roundNum);
    butlerContainer.insertAdjacentHTML('beforeend', butlerHtml);
    // 移除旧条目
    const butlerCards = butlerContainer.querySelectorAll('.debug-card');
    while (butlerCards.length > MAX_DEBUG_ENTRIES) {
      butlerCards[0].remove();
    }
    requestAnimationFrame(() => { butlerContainer.scrollTop = butlerContainer.scrollHeight; });
  }
}

function clearDebugPanel() {
  AppState.debugRoundCounter = 0;
  DOM.debugMainAgentContent().innerHTML = '<div class="debug-empty">主Agent 输出将在此显示（含思维链、完整输出等）</div>';
  DOM.debugButlerContent().innerHTML = '<div class="debug-empty">管家AI 处理记录将在此显示（含思维链、portrait/CG判定等）</div>';
}

// 调试面板子Tab切换
function switchDebugSubTab(subtab) {
  AppState.activeDebugSubTab = subtab;
  // Update sub-tab buttons
  document.querySelectorAll('.debug-sub-tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.subtab === subtab);
  });
  // Show/hide sub-tab content
  DOM.debugMainAgentContent().classList.toggle('active', subtab === 'mainAgent');
  DOM.debugButlerContent().classList.toggle('active', subtab === 'butler');
}

// === Debug card toggle ===
function toggleDebugCard(id) {
  const card = document.getElementById(id);
  if (!card) return;
  const body = card.querySelector('.debug-card-body');
  const arrow = card.querySelector('.debug-card-arrow');
  if (!body || !arrow) return;
  const isHidden = body.style.display === 'none';
  body.style.display = isHidden ? 'block' : 'none';
  arrow.textContent = isHidden ? '▼' : '▶';
}

// Font size control for debug pre
function setDebugFontSize(delta) {
  const current = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--debug-font') || '13');
  const next = Math.max(10, Math.min(20, current + delta));
  document.documentElement.style.setProperty('--debug-font', next + 'px');
}

// ============ 输入框处理 ============

function handleInputChange() {
  updateSendButton();
  autoResizeInput();
}

function handleInputKeydown(e) {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    sendMessage();
  }
}

// ============ Token 计数器 ============

/**
 * 粗略估算文本 token 数（中文~1.5字符/token，英文~4字符/token）
 */
function estimateTokens(text) {
  if (!text) return 0;
  const cn = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const en = text.length - cn;
  return Math.ceil(cn / 1.5 + en / 4);
}

function updateTokenCounter() {
  // Token stats are now provided by the backend (includes system prompt, character card, preset, etc.)
  // This function only updates the UI display
  DOM.tokenContext().textContent = formatTokenNum(AppState.tokenContext);
  DOM.tokenTotal().textContent = formatTokenNum(AppState.tokenTotal);
}

/**
 * Update token stats from backend response
 * @param {object} tokenStats - { contextTokens, systemTokens, historyTokens, cumulativeTotal }
 */
function setTokenStats(tokenStats) {
  if (!tokenStats) return;
  AppState.tokenContext = tokenStats.contextTokens || 0;
  AppState.tokenTotal = tokenStats.cumulativeTotal || 0;
  AppState.systemTokens = tokenStats.systemTokens || 0;
  updateTokenCounter();
}

/**
 * Load token stats from backend for current conversation
 */
async function loadTokenStats() {
  if (!AppState.currentConversation?.id) return;
  try {
    const stats = await request(`/chat/token-stats/${AppState.currentConversation.id}`);
    setTokenStats(stats);
  } catch (e) {
    console.warn('[TokenStats] Failed to load:', e.message);
  }
}

function addToTokenTotal(text) {
  // Token stats are now managed by backend
  // This function is kept for compatibility but no longer does manual counting
}

function formatTokenNum(n) {
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}

async function updateMessage(msgId, newContent) {
  try {
    await request(`/messages/${msgId}`, { method: 'PUT', body: { content: newContent } });
    showToast('消息已更新', 'success');
  } catch (err) {
    showToast('更新失败: ' + err.message, 'error');
  }
}

// ============ CG 画廊轮询 ============

async function pollCGGallery(retries = 30) {
  const saveId = getCurrentSaveId();
  if (!saveId) return;
  const initialTimestamp = (AppState.cgGallery || [])[0]?.timestamp || '';
  for (let i = 0; i < retries; i++) {
    await new Promise(r => setTimeout(r, 2000));
    try {
      const resp = await request('/saves/' + saveId + '/cg-gallery');
      if (resp?.gallery) {
        const newTimestamp = resp.gallery[0]?.timestamp || '';
        if (newTimestamp !== initialTimestamp || resp.gallery.length !== (AppState.cgGallery || []).length) {
          AppState.cgGallery = resp.gallery;
          renderGallery();
          console.log('[CG] Gallery updated');
          return;
        }
      }
    } catch { /* retry */ }
  }
}

// ============ 统一画廊轮询（imagePending 触发） ============

let _galleryPollTimer = null;

/**
 * 启动画廊轮询：后端通知 imagePending 后调用
 * 同时检测 CG 画廊更新和角色头像更新
 * 轮询间隔：前30秒每3秒，之后每5秒，最多3分钟
 */
function startGalleryPoll() {
  // 防止重复启动
  if (_galleryPollTimer) return;

  const saveId = getCurrentSaveId();
  if (!saveId) return;

  const initialCGCount = (AppState.cgGallery || []).length;
  let phase = 'fast'; // fast=3s, slow=5s
  let totalElapsed = 0;
  const MAX_DURATION = 180000; // 3 minutes max

  console.log('[GalleryPoll] Starting, initial CG count:', initialCGCount);

  async function tick() {
    if (!_galleryPollTimer) return; // stopped

    const interval = phase === 'fast' ? 3000 : 5000;
    totalElapsed += interval;

    if (totalElapsed > MAX_DURATION) {
      _galleryPollTimer = null;
      console.log('[GalleryPoll] Timeout, stopping');
      return;
    }

    // Switch to slow phase after 30s
    if (phase === 'fast' && totalElapsed >= 30000) {
      phase = 'slow';
      console.log('[GalleryPoll] Switching to slow poll (5s)');
    }

    let updated = false;

    try {
      const resp = await request('/saves/' + saveId + '/cg-gallery');
      if (resp?.gallery) {
        // Detect new CG entries (count increase)
        if (resp.gallery.length !== initialCGCount) {
          AppState.cgGallery = resp.gallery;
          updated = true;
          console.log('[GalleryPoll] CG updated, count:', resp.gallery.length);
        }
        // Detect timestamp change (regenerated CG on same count)
        if (resp.gallery.length === initialCGCount && initialCGCount > 0) {
          const newTs = resp.gallery[0]?.timestamp || '';
          const oldTs = (AppState.cgGallery || [])[0]?.timestamp || '';
          if (newTs !== oldTs) {
            AppState.cgGallery = resp.gallery;
            updated = true;
            console.log('[GalleryPoll] CG updated (timestamp changed)');
          }
        }
      }
    } catch { /* ignore */ }

    try {
      const rosterResp = await request('/saves/' + saveId + '/roster');
      if (rosterResp?.roster) {
        let avatarUpdated = false;
        for (const [name, data] of Object.entries(rosterResp.roster)) {
          const newAv = data.avatar;
          const oldAv = AppState.characterRoster[name]?.avatar;
          // Detect: new real avatar (not pending/empty) that we didn't have before
          // or avatar changed from pending → actual file
          const isNewRealAvatar = newAv && newAv !== 'pending' && newAv !== '';
          const hadNoRealAvatar = !oldAv || oldAv === 'pending' || oldAv === '';
          if (isNewRealAvatar && hadNoRealAvatar) {
            avatarUpdated = true;
            break;
          }
        }
        if (avatarUpdated) {
          AppState.characterRoster = rosterResp.roster;
          await loadCharacterColors();
          updateRenderedAvatars();
          // Also force avatar images to reload by adding cache-busting timestamp
          document.querySelectorAll('.dialogue-avatar img').forEach(img => {
            const src = img.getAttribute('src');
            if (src && src.includes('/avatar/')) {
              const base = src.split('?')[0];
              img.setAttribute('src', base + '?t=' + Date.now());
            }
          });
          updated = true;
          console.log('[GalleryPoll] Portrait updated');
        }
      }
    } catch { /* ignore */ }

    if (updated) {
      renderGallery();
    }

    // Schedule next tick
    const nextInterval = phase === 'fast' ? 3000 : 5000;
    _galleryPollTimer = setTimeout(tick, nextInterval);
  }

  // Start first tick after 3s (give backend time to start generating)
  _galleryPollTimer = setTimeout(tick, 3000);
}

/**
 * 停止画廊轮询
 */
function stopGalleryPoll() {
  if (_galleryPollTimer) {
    clearTimeout(_galleryPollTimer);
    _galleryPollTimer = null;
    console.log('[GalleryPoll] Stopped');
  }
}

// ============ 头像灯箱 ============

function showAvatarLightbox(src) {
  const lb = document.createElement('div');
  lb.className = 'avatar-lightbox';
  lb.innerHTML = `<img src="${escapeHtml(src)}" alt="头像">`;
  lb.addEventListener('click', () => lb.remove());
  document.body.appendChild(lb);
}

async function deleteMessage(msgId) {
  if (!confirm('确定删除此消息？')) return;
  try {
    await request(`/messages/${msgId}`, { method: 'DELETE' });
    // 从界面上移除
    const el = DOM.messagesArea().querySelector(`[data-id="${msgId}"]`);
    if (el) el.remove();
    // 从 app state 移除
    AppState.messages = AppState.messages.filter(m => m.id !== msgId);
    updateTokenCounter();
    showToast('消息已删除', 'success');
  } catch (err) {
    showToast('删除失败', 'error');
  }
}

/**
 * 从 AI 文本中解析状态栏并更新 userStatus
 * 格式: 姓名: 我 / 年龄: 16 / 修为阶段: 练体境初期 等
 */
function parseStatusSection(text) {
  if (!text) return;
  const statusObj = {};
  // 支持两种格式：每行一个 key：value，或用 ； 分隔
  const lines = text.includes('；') ? text.split(/[；;]/) : text.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // 查找 : 或 ：
    const idx = trimmed.indexOf('：') >= 0 ? trimmed.indexOf('：') : trimmed.indexOf(':');
    if (idx < 0) continue;
    const key = trimmed.slice(0, idx).trim();
    let val = trimmed.slice(idx + 1).trim();
    // 清理尾部括号注释如 [15/100]
    val = val.replace(/\[.*\]$/, '').trim();
    if (key && val) statusObj[key] = val;
  }
  if (Object.keys(statusObj).length > 0) {
    Object.entries(statusObj).forEach(([k, v]) => {
      AppState.userStatus[k] = v;
    });
    renderStatusBar();
  }
}

// ============ Portrait 轮询更新 ============

async function pollPortraitReady(charName, retries = 30) {
  const saveId = getCurrentSaveId();
  if (!saveId) return;
  for (let i = 0; i < retries; i++) {
    await new Promise(r => setTimeout(r, 2000)); // 每2秒检查一次
    try {
      const resp = await request('/saves/' + saveId + '/roster');
      if (resp && resp.roster && resp.roster[charName] && resp.roster[charName].avatar) {
        // 头像已生成，刷新名册
        await loadCharacterColors();
        // 更新已渲染的对话头像
        updateRenderedAvatars();
        console.log('[Portrait] Avatar ready for:', charName);
        return;
      }
    } catch { /* retry */ }
  }
  console.log('[Portrait] Timeout waiting for:', charName);
}

function updateRenderedAvatars() {
  document.querySelectorAll('.dialogue-avatar').forEach(avatarEl => {
    const parent = avatarEl.closest('.dialog-wrapper');
    if (!parent) return;
    const nameEl = parent.querySelector('.dialogue-name');
    const name = nameEl ? nameEl.textContent.trim() : '';
    if (!name) return;
    // 用户侧（真实身份 / 游戏内扮演身份）：始终用用户头像刷新
    if (isUserSideName(name)) {
      const av = getUserAvatarForName(name);
      if (av) {
        avatarEl.innerHTML = `<img src="${escapeHtml(av)}?t=${Date.now()}" alt="${escapeHtml(name)}">`;
      } else {
        avatarEl.innerHTML = escapeHtml(name.charAt(0));
      }
      return;
    }
    const result = lookupRosterEntry(name);
    // Only update if avatar is a real file (not 'pending' or empty)
    const rosterEntry = result?.entry;
    const rosterName = result?.matchName || name;
    if (rosterEntry && rosterEntry.avatar && rosterEntry.avatar !== 'pending' && rosterEntry.avatar !== '') {
      const avatarPath = '/api/saves/' + getCurrentSaveId() + '/avatar/' + encodeURIComponent(rosterName) + '?t=' + Date.now();
      avatarEl.innerHTML = `<img src="${escapeHtml(avatarPath)}" alt="${escapeHtml(name)}">`;
    }
  });
}

// ============ edit modal ============

let _editingMsgId = null;

function showEditModal(msgId) {
  const msg = AppState.messages.find(m => m.id === msgId);
  if (!msg) { showToast('找不到消息', 'error'); return; }
  _editingMsgId = msgId;
  DOM.editTextarea().value = msg.content || '';
  DOM.editModal().classList.remove('hidden');
  setTimeout(() => DOM.editTextarea().focus(), 100);
}

function closeEditModal() {
  DOM.editModal().classList.add('hidden');
  _editingMsgId = null;
}

async function saveEditModal() {
  const newContent = DOM.editTextarea().value;
  if (!_editingMsgId || !newContent) return;

  const msg = AppState.messages.find(m => m.id === _editingMsgId);
  if (!msg) return;

  // For AI messages, re-parse the template so formatted data stays in sync
  if (msg.role === 'assistant') {
    try {
      const resp = await fetch('/api/chat/reparse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: newContent }),
      });
      if (resp.ok) {
        const parsed = await resp.json();
        msg.formatted = parsed;
      }
    } catch { /* keep old formatted if reparse fails */ }
  }

  msg.content = newContent;

  try {
    await fetch('/api/messages/' + _editingMsgId, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: newContent, formatted: msg.formatted || {} }),
    });
    showToast('消息已保存', 'success');
  } catch (err) {
    showToast('保存失败: ' + err.message, 'error');
  }

  closeEditModal();
  renderMessages();
}

function updateSendButton() {
  const btn = DOM.btnSend();
  const hasText = DOM.messageInput().value.trim().length > 0;

  if (AppState.isGenerating) {
    // 生成中 → 红色停止按钮
    btn.disabled = false;
    btn.textContent = '停止';
    btn.classList.add('btn-stop');
    btn.title = '中止生成';
  } else {
    btn.disabled = !hasText;
    btn.textContent = '发送';
    btn.classList.remove('btn-stop');
    btn.title = '';
  }
}

/**
 * 中止当前 AI 生成
 */
async function abortGeneration() {
  try {
    showToast('正在中止...', 'warning', 2000);
    await ChatAPI.abort();
  } catch (err) {
    console.error('[Abort] 失败:', err);
  }
  AppState.isGenerating = false;
  updateSendButton();
}

function autoResizeInput() {
  const input = DOM.messageInput();
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 120) + 'px';
}

// ============ 打字指示器 ============

function showTypingIndicator() {
  const area = DOM.messagesArea();
  if (area.querySelector('.typing-indicator')) return;

  const indicator = document.createElement('div');
  indicator.className = 'story-block assistant typing-indicator-wrapper';
  indicator.innerHTML = `
    <div class="narration-text ai-streaming">
      <div class="typing-indicator"><span></span><span></span><span></span></div>
    </div>
  `;
  area.appendChild(indicator);
  scrollToBottom();
}

function hideTypingIndicator() {
  const indicator = DOM.messagesArea().querySelector('.typing-indicator-wrapper');
  if (indicator) indicator.remove();
}

function scrollToBottom() {
  // 不再自动滚动 — 用户自行控制
}

/**
 * Scroll to the top of the current (most recent) conversation round.
 * Finds the last story-block whose round number matches the latest one.
 */
/**
 * ★ 长聊天渲染缓存与滚动漂移（2026-08-16 修复）：
 *   .story-block 使用 content-visibility:auto，屏外块仅按 contain-intrinsic-size(200px) 占位。
 *   一次性 scrollTo/scrollIntoView 跳转后，进入视口的块被真实渲染、整体高度增长，
 *   导致滚动停在半路（无法到达末尾 / 目标块开头漂移）。
 *   解决：立即跳转（非平滑），随后逐帧校正，直至 (scrollTop, scrollHeight) 稳定；
 *   用户手动滚动（滚轮/触摸）时立即中断校正，不打断用户操作。
 */
let _scrollSettleGen = 0;

function _settleScrollLoop(area, jumpFn) {
  const gen = ++_scrollSettleGen;
  let lastKey = '';
  let stable = 0;
  let frames = 0;
  // 用户主动滚动时放弃校正（gen 自增使本循环失效）
  const cancel = () => { _scrollSettleGen++; };
  area.addEventListener('wheel', cancel, { once: true, passive: true });
  area.addEventListener('touchmove', cancel, { once: true, passive: true });

  const tick = () => {
    if (gen !== _scrollSettleGen) return; // 已被新跳转或用户滚动取代
    jumpFn();
    frames++;
    const key = area.scrollTop + '/' + area.scrollHeight;
    stable = (key === lastKey) ? stable + 1 : 0;
    lastKey = key;
    if (stable >= 3) return;   // 连续 3 帧稳定 → 已到达目标
    if (frames >= 90) return;  // 上限 ~1.5s，防御性退出
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/** ▼ 立即滚动到聊天记录末尾（多帧校正确保真正贴底） */
function scrollToEndImmediately() {
  const area = DOM.messagesArea();
  if (!area) return;
  area.scrollTop = area.scrollHeight; // 立即跳转（非平滑）
  _settleScrollLoop(area, () => {
    if (area.scrollTop + area.clientHeight < area.scrollHeight - 2) {
      area.scrollTop = area.scrollHeight;
    }
  });
}

/**
 * ■ 移到最后一条消息的开头（最后一个 .story-block 顶部）。
 * 立即跳转 + 多帧校正（上方中间块被真实渲染展开后会把目标块往下推）。
 */
function scrollToLastMessageStart() {
  const area = DOM.messagesArea();
  if (!area) return;
  const blocks = area.querySelectorAll('.story-block');
  if (blocks.length === 0) return;
  const target = blocks[blocks.length - 1];

  const jumpFn = () => {
    const top = target.getBoundingClientRect().top - area.getBoundingClientRect().top + area.scrollTop;
    if (Math.abs(area.scrollTop - top) > 1) area.scrollTop = top;
  };
  jumpFn(); // 立即跳转（非平滑）
  _settleScrollLoop(area, jumpFn);
}

/* ============================================================
 * ★ 聊天渲染缓存分片（2026-08-16 方案）：
 *   - 第一条消息和最后一条消息（.cv-edge）始终真实渲染进缓存，不做分片；
 *   - 只有中间部分的消息（.cv-mid）使用 content-visibility:auto 分片占位；
 *   - 这样 ▼（末尾）/■（最后一条开头）快捷按钮的目标块永远有真实尺寸与位置。
 *   通过 MutationObserver 监听消息区直接子节点增删自动重新标记，
 *   覆盖初始渲染、流式追加、删除、重启等所有路径。
 * ============================================================ */
let _chatChunkObserver = null;

/** 重新标记首尾消息：首尾 → cv-edge（真实渲染），其余 → cv-mid（分片） */
function applyChatRenderChunking() {
  const area = DOM.messagesArea();
  if (!area) return;
  const blocks = area.querySelectorAll('.story-block');
  const n = blocks.length;
  blocks.forEach((b, i) => {
    if (n <= 2 || i === 0 || i === n - 1) {
      b.classList.add('cv-edge');
      b.classList.remove('cv-mid');
    } else {
      b.classList.add('cv-mid');
      b.classList.remove('cv-edge');
    }
  });
}

/** 初始化分片标记 + 变更监听（幂等，可重复调用） */
function initChatRenderChunking() {
  const area = DOM.messagesArea();
  if (!area || _chatChunkObserver) return;
  _chatChunkObserver = new MutationObserver(() => applyChatRenderChunking());
  // 只监听直接子节点增删（.story-block / 加载条 / 打字指示器），流式内部更新不触发
  _chatChunkObserver.observe(area, { childList: true });
  applyChatRenderChunking();
}

// ============ 角色弹窗 ============

async function openCharacterModal(characterId = null) {
  const modal = DOM.characterModal();
  const title = DOM.characterModalTitle();
  AppState._cardMetadata = null;  // Reset

  // Guard: treat non-UUID values (null, undefined, "null", "undefined", "") as new
  const isValidId = characterId && typeof characterId === 'string' && /^[0-9a-f]{8}-/i.test(characterId);

  if (isValidId) {
    AppState.editingCharacterId = characterId;
    title.textContent = '编辑角色';
    try {
      const char = await CharacterAPI.get(characterId);
      DOM.charName().value = char.name || '';
      DOM.charAvatar().value = char.avatar || '';
      DOM.charPersonality().value = char.personality || '';
      DOM.charDescription().value = char.description || '';
      DOM.charScenario().value = char.scenario || '';
      DOM.charFirstMessage().value = char.first_message || '';
      DOM.charSystemPrompt().value = char.system_prompt || '';
      DOM.charPostHistory().value = char.post_history_instructions || '';
      DOM.charTags().value = parseTags(char.tags).join(', ');
      // Load existing metadata
      try {
        if (char.metadata && typeof char.metadata === 'string') {
          AppState._cardMetadata = JSON.parse(char.metadata);
        } else if (char.metadata) {
          AppState._cardMetadata = char.metadata;
        }
      } catch (e) { AppState._cardMetadata = null; }
      // Load world book entries
      try {
        const bookData = await CharacterAPI.getBook(characterId);
        AppState.worldBookEntries = bookData.entries || [];
        AppState._worldBookCooldown = bookData.cooldown ?? 4;
        // Set master toggle state
        const bookActive = bookData.book_activation && bookData.book_activation !== 'off';
        const toggle = document.getElementById('charBookActivation');
        const label = document.getElementById('bookActivationLabel');
        if (toggle) toggle.checked = bookActive;
        if (label) label.textContent = bookActive ? '开启' : '关闭';
      } catch (e) {
        AppState.worldBookEntries = [];
        // Fallback: try parsing from character_book field
        try {
          const raw = char.character_book;
          if (raw) {
            const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
            let entries = parsed.entries || [];
            if (!Array.isArray(entries) && typeof entries === 'object') entries = Object.values(entries);
            AppState.worldBookEntries = entries;
          }
        } catch (e2) { AppState.worldBookEntries = []; }
      }
      renderWorldBookEntries();
    } catch (err) {
      showToast('加载角色信息失败', 'error');
      return;
    }
  } else {
    AppState.editingCharacterId = null;
    title.textContent = '新建角色';
    DOM.characterForm().reset();
    AppState.worldBookEntries = [];
    // Reset master toggle to off
    const toggleNew = document.getElementById('charBookActivation');
    const labelNew = document.getElementById('bookActivationLabel');
    if (toggleNew) toggleNew.checked = false;
    if (labelNew) labelNew.textContent = '关闭';
    renderWorldBookEntries();
  }

  modal.classList.remove('hidden');
}

function closeCharacterModal() {
  DOM.characterModal().classList.add('hidden');
  AppState.editingCharacterId = null;
  AppState.worldBookEntries = [];
}

// ============ World Book Entry Management ============

function renderWorldBookEntries() {
  const section = DOM.worldBookSection();
  const list = DOM.wbEntriesList();
  const countEl = DOM.wbEntryCount();
  const entries = AppState.worldBookEntries;

  // Always show world book section when there are entries, or always show it for editing
  section.style.display = '';

  // Set cooldown from saved data
  const cooldownInput = document.getElementById('wbCooldown');
  if (cooldownInput && AppState._worldBookCooldown !== undefined) {
    cooldownInput.value = AppState._worldBookCooldown;
  }

  // Update count
  const enabledCount = entries.filter(e => e.enabled).length;
  countEl.textContent = `${enabledCount}/${entries.length} 条`;

  // Render entries
  if (entries.length === 0) {
    list.innerHTML = '<div style="padding:12px;text-align:center;color:var(--text-muted);font-size:12px">暂无世界书条目</div>';
    return;
  }

  list.innerHTML = entries.map((entry, idx) => renderWBEntryHTML(entry, idx)).join('');
}

function renderWBEntryHTML(entry, idx) {
  const isOpen = entry._open ? 'open' : '';
  const isConstant = entry.constant;
  const isSelective = entry.selective;
  const typeClass = isConstant ? 'wb-type-constant' : isSelective ? 'wb-type-selective' : 'wb-type-keyword';
  const typeLabel = isConstant ? '常驻' : isSelective ? '选择' : '关键词';
  const nameClass = entry.enabled ? 'wb-entry-name' : 'wb-entry-name disabled';

  const keys = Array.isArray(entry.keys) ? entry.keys : [];
  const secondaryKeys = Array.isArray(entry.secondary_keys) ? entry.secondary_keys : [];

  return `
    <div class="wb-entry" data-idx="${idx}">
      <div class="wb-entry-header" onclick="toggleWBEntry(${idx})">
        <span class="wb-entry-toggle ${isOpen}">&#9654;</span>
        <label class="wb-entry-switch" onclick="event.stopPropagation()">
          <input type="checkbox" ${entry.enabled ? 'checked' : ''} onchange="toggleWBEntryEnabled(${idx})">
          <span class="slider"></span>
        </label>
        <span class="${nameClass}">${escapeHtml(entry.comment || entry.content?.slice(0, 40) || '条目 ' + (entry.id ?? idx))}</span>
        <span class="wb-entry-type ${typeClass}">${typeLabel}</span>
        <span class="wb-entry-delete" onclick="event.stopPropagation();deleteWBEntry(${idx})" title="删除">&#10005;</span>
      </div>
      <div class="wb-entry-body ${isOpen}">
        <div class="wb-field">
          <label>备注/名称</label>
          <input type="text" value="${escapeHtml(entry.comment || '')}" onchange="updateWBField(${idx},'comment',this.value)" placeholder="条目备注...">
        </div>
        <div class="wb-field">
          <label>激活方式</label>
          <div class="wb-activation-select">
            <select onchange="updateWBActivation(${idx},this.value)">
              <option value="keyword" ${!isConstant && !isSelective ? 'selected' : ''}>关键词触发</option>
              <option value="constant" ${isConstant ? 'selected' : ''}>常驻激活</option>
              <option value="selective" ${isSelective ? 'selected' : ''}>选择性(主键+次键)</option>
            </select>
          </div>
        </div>
        <div class="wb-field">
          <label>主关键词 (逗号分隔)</label>
          <div class="wb-keys-input" onclick="this.querySelector('input').focus()">
            ${keys.map((k, ki) => `<span class="wb-key-tag">${escapeHtml(k)}<span class="wb-key-remove" onclick="event.stopPropagation();removeWBKey(${idx},'keys',${ki})">&times;</span></span>`).join('')}
            <input type="text" placeholder="输入关键词回车添加" onkeydown="addWBKey(event,${idx},'keys')">
          </div>
        </div>
        ${isSelective ? `
        <div class="wb-field">
          <label>次要关键词 (逗号分隔)</label>
          <div class="wb-keys-input" onclick="this.querySelector('input').focus()">
            ${secondaryKeys.map((k, ki) => `<span class="wb-key-tag" style="background:#a040f0">${escapeHtml(k)}<span class="wb-key-remove" onclick="event.stopPropagation();removeWBKey(${idx},'secondary_keys',${ki})">&times;</span></span>`).join('')}
            <input type="text" placeholder="输入次要关键词回车添加" onkeydown="addWBKey(event,${idx},'secondary_keys')">
          </div>
        </div>` : ''}
        <div class="wb-field">
          <label>内容</label>
          <textarea rows="4" onchange="updateWBField(${idx},'content',this.value)" placeholder="世界书条目内容...">${escapeHtml(entry.content || '')}</textarea>
        </div>
        <div class="wb-field-row">
          <div class="wb-field">
            <label>插入位置</label>
            <select onchange="updateWBField(${idx},'position',this.value)">
              <option value="before_char" ${entry.position === 'before_char' ? 'selected' : ''}>角色定义前</option>
              <option value="after_char" ${entry.position !== 'before_char' ? 'selected' : ''}>角色定义后</option>
            </select>
          </div>
          <div class="wb-field">
            <label>插入顺序</label>
            <input type="text" value="${entry.insertion_order ?? 100}" onchange="updateWBField(${idx},'insertion_order',parseInt(this.value)||100)">
          </div>
          <div class="wb-field">
            <label>扫描深度</label>
            <input type="text" value="${entry.extensions?.scan_depth ?? ''}" onchange="updateWBExtField(${idx},'scan_depth',this.value?parseInt(this.value):null)" placeholder="默认">
          </div>
        </div>
      </div>
    </div>`;
}

function toggleWBEntry(idx) {
  AppState.worldBookEntries[idx]._open = !AppState.worldBookEntries[idx]._open;
  renderWorldBookEntries();
}

function toggleWBEntryEnabled(idx) {
  AppState.worldBookEntries[idx].enabled = !AppState.worldBookEntries[idx].enabled;
  renderWorldBookEntries();
}

// Master switch toggle for world book (on/off)
function toggleBookActivation(checked) {
  const label = document.getElementById('bookActivationLabel');
  if (label) label.textContent = checked ? '开启' : '关闭';
}

function updateWBField(idx, field, value) {
  AppState.worldBookEntries[idx][field] = value;
}

function updateWBExtField(idx, field, value) {
  if (!AppState.worldBookEntries[idx].extensions) AppState.worldBookEntries[idx].extensions = {};
  AppState.worldBookEntries[idx].extensions[field] = value;
}

function updateWBActivation(idx, mode) {
  const entry = AppState.worldBookEntries[idx];
  entry.constant = mode === 'constant';
  entry.selective = mode === 'selective';
  renderWorldBookEntries();
}

function addWBKey(event, idx, field) {
  if (event.key !== 'Enter' && event.key !== ',') return;
  event.preventDefault();
  const input = event.target;
  const value = input.value.trim();
  if (!value) return;
  if (!AppState.worldBookEntries[idx][field]) AppState.worldBookEntries[idx][field] = [];
  AppState.worldBookEntries[idx][field].push(value);
  input.value = '';
  renderWorldBookEntries();
}

function removeWBKey(idx, field, keyIdx) {
  AppState.worldBookEntries[idx][field].splice(keyIdx, 1);
  renderWorldBookEntries();
}

function deleteWBEntry(idx) {
  if (!confirm('确定删除此世界书条目？')) return;
  AppState.worldBookEntries.splice(idx, 1);
  renderWorldBookEntries();
}

function addNewWBEntry() {
  const newId = AppState.worldBookEntries.length > 0
    ? Math.max(...AppState.worldBookEntries.map(e => e.id ?? 0)) + 1 : 0;
  AppState.worldBookEntries.push({
    id: newId, keys: [], secondary_keys: [], comment: '', content: '',
    constant: false, selective: false, insertion_order: 100, enabled: true,
    position: 'before_char', _open: true,
    extensions: { depth: 4, role: 0, selective_logic: 0, group: '', display_index: 0 },
  });
  renderWorldBookEntries();
  // Scroll to bottom
  DOM.wbEntriesList().scrollTop = DOM.wbEntriesList().scrollHeight;
}

async function saveCharacter() {
  const bookToggle = document.getElementById('charBookActivation');
  const bookActivation = bookToggle && bookToggle.checked ? 'on' : 'off';
  const data = {
    name: DOM.charName().value.trim(),
    avatar: DOM.charAvatar().value.trim(),
    personality: DOM.charPersonality().value.trim(),
    description: DOM.charDescription().value.trim(),
    scenario: DOM.charScenario().value.trim(),
    first_message: DOM.charFirstMessage().value.trim(),
    system_prompt: DOM.charSystemPrompt().value.trim(),
    post_history_instructions: DOM.charPostHistory().value.trim(),
    tags: DOM.charTags().value.split(',').map(t => t.trim()).filter(Boolean),
    book_activation: bookActivation,
  };

  // 包含修卡时 AI 分析的文化/性别 metadata
  if (AppState._cardMetadata) {
    data.metadata = AppState._cardMetadata;
  }

  if (!data.name) {
    showToast('角色名称不能为空', 'warning');
    return;
  }

  try {
    // Guard: editingCharacterId must be a valid UUID
    const isValidEditId = AppState.editingCharacterId &&
      typeof AppState.editingCharacterId === 'string' &&
      /^[0-9a-f]{8}-/i.test(AppState.editingCharacterId);

    if (isValidEditId) {
      await CharacterAPI.update(AppState.editingCharacterId, data);
      // Save world book entries separately
      if (AppState.worldBookEntries.length > 0) {
        await CharacterAPI.updateBook(AppState.editingCharacterId, {
          entries: AppState.worldBookEntries,
          cooldown: AppState._worldBookCooldown ?? 4,
          book_activation: bookActivation,
        });
      }
      showToast('角色已更新', 'success');
    } else {
      // New character: create first, then save world book if needed
      const result = await CharacterAPI.create(data);
      const newCharId = result.id;
      if (newCharId && AppState.worldBookEntries.length > 0) {
        await CharacterAPI.updateBook(newCharId, {
          entries: AppState.worldBookEntries,
          cooldown: AppState._worldBookCooldown ?? 4,
          book_activation: bookActivation,
        });
      }
      showToast('角色已创建', 'success');
    }

    closeCharacterModal();
    AppState.characters = await CharacterAPI.list();
    renderStripAvatars();
    renderCharacterList();
  } catch (err) {
    console.error('[SaveCharacter] 失败:', err);
    showToast('保存角色失败', 'error');
  }
}

async function fixCharacterCard() {
  const systemPrompt = DOM.charSystemPrompt().value.trim();
  const personality = DOM.charPersonality().value.trim();
  const description = DOM.charDescription().value.trim();
  const postHistory = DOM.charPostHistory().value.trim();

  if (!systemPrompt && !personality && !description) {
    showToast('请先填写系统提示词或性格描述', 'warning');
    return;
  }

  const btn = DOM.btnFixCharacter();
  btn.disabled = true;
  btn.textContent = '修卡中...';
  showToast('AI 正在优化角色卡，请稍候...', 'info', 0);

  try {
    const result = await CardFixerAPI.fix({
      system_prompt: systemPrompt,
      personality: personality,
      description: description,
      post_history_instructions: postHistory,
      character_id: AppState.currentCharacter ? AppState.currentCharacter.id : undefined,
    });

    if (result.fixed_prompt) {
      DOM.charSystemPrompt().value = result.fixed_prompt;
      // 清空其他字段（已合并到系统提示词）
      DOM.charPostHistory().value = '';

      // MVU 修卡：更新内存中的 mvu_meta，使状态面板立即反映中文变量与分组
      if (result.mvu && result.mvu_meta && AppState.currentCharacter) {
        AppState.currentCharacter.mvu_meta = result.mvu_meta;
        AppState.currentCharacter.markup_mode = 'game-xml';
        if (typeof AppState.currentCharacter.metadata === 'string') {
          try {
            const m = JSON.parse(AppState.currentCharacter.metadata);
            m.ui_hints = { hasMVU: true, requiresStatus: false };
            AppState.currentCharacter.metadata = JSON.stringify(m);
          } catch { /* ignore */ }
        } else if (AppState.currentCharacter.metadata && typeof AppState.currentCharacter.metadata === 'object') {
          AppState.currentCharacter.metadata.ui_hints = { hasMVU: true, requiresStatus: false };
        }
        if (typeof renderWorldStatePanel === 'function') { try { renderWorldStatePanel(); } catch {} }
      }

      // 存储 AI 分析的文化/性别 metadata（含 MVU UI hint，供保存时一并写入）
      if (result.metadata) {
        AppState._cardMetadata = result.metadata;
        const extra = result.mvu ? '（MVU 变量已适配）' : '';
        showToast('角色卡已优化！文化: ' + result.metadata.culture + ' | 性别: ' + result.metadata.gender + extra, 'success');
      } else {
        showToast('角色卡已优化！请检查并手动保存', 'success');
      }
    }
  } catch (err) {
    console.error('[FixCharacter] 失败:', err);
    showToast('修卡失败: ' + (err.message || '未知错误'), 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '🔧 一键修卡';
  }
}

async function deleteCharacter(characterId) {
  if (!confirm('确定要删除该角色吗？相关对话也将被删除。')) return;

  try {
    await CharacterAPI.delete(characterId);
    showToast('角色已删除', 'success');

    if (AppState.currentCharacter && AppState.currentCharacter.id === characterId) {
      AppState.currentCharacter = null;
      AppState.currentConversation = null;
      AppState.messages = [];
      AppState.totalMessages = 0;
      AppState._messagesFullyLoaded = false;
      renderLoadEarlierBar();
      AppState.userStatus = {};
      AppState.galleryImages = [];
      AppState.cgGallery = [];
      AppState._currentSaveId = '';
      DOM.welcomeScreen().classList.remove('hidden');
      DOM.chatContainer().classList.add('hidden');
      DOM.conversationTitle().textContent = '选择角色开始对话';
      renderStatusBar();
      renderGallery();
    }

    AppState.characters = await CharacterAPI.list();
    renderStripAvatars();
    renderCharacterList();
  } catch (err) {
    console.error('[DeleteCharacter] 失败:', err);
    showToast('删除角色失败', 'error');
  }
}

// ============ 角色卡导入 ============

/**
 * Build a string from a (potentially very large) Uint8Array of char codes,
 * in fixed-size chunks to avoid the "Maximum call stack size exceeded" error
 * that String.fromCharCode(...bigArray) throws for large arrays (e.g. >1MB cards).
 */
function decodeBytesToString(byteArr) {
  const CHUNK = 0x8000;
  let out = '';
  for (let i = 0; i < byteArr.length; i += CHUNK) {
    out += String.fromCharCode.apply(null, byteArr.subarray(i, i + CHUNK));
  }
  return out;
}

/**
 * Extract the first image URL from a markdown image link: ![alt](url) or ![](url).
 * Returns null if not present.
 */
function extractMarkdownImageUrl(text) {
  if (typeof text !== 'string') return null;
  const m = text.match(/!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/);
  return m ? m[1].trim() : null;
}

/**
 * Resolve a character card's avatar from common SillyTavern fields
 * (avatar / char_image / image / icon), recognizing:
 *  - plain http(s): / data: / blob: / absolute-path URLs
 *  - markdown image links: ![alt](url) / ![](url)
 *  - a bare relative path/extension
 * Falls back to the first markdown image at the very start of description
 * (a common pattern in some original cards whose avatar is stored as markdown).
 */
function resolveCardAvatar(data) {
  if (!data || typeof data !== 'object') return '';
  const candidates = [data.avatar, data.char_image, data.image, data.icon];
  for (const v of candidates) {
    if (typeof v === 'string' && v.trim()) {
      const t = v.trim();
      if (/^(https?:|data:|blob:|\/|file:)/i.test(t)) return t;
      const md = extractMarkdownImageUrl(t);
      if (md) return md;
      if (/\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i.test(t) || (t.includes('/') && !t.includes(' '))) return t;
    }
  }
  // Fallback: description begins with a markdown image → treat as avatar
  const desc = typeof data.description === 'string' ? data.description.trim() : '';
  if (desc.startsWith('![') || desc.startsWith('![](')) {
    const di = extractMarkdownImageUrl(desc);
    if (di) return di;
  }
  return '';
}

async function handleCharacterImport(e) {
  const file = e.target.files[0];
  if (!file) return;

  try {
    let data;

    if (file.name.toLowerCase().endsWith('.png')) {
      // SillyTavern PNG character card: extract JSON from 'chara' tEXt chunk
      data = await extractPNGCharacterData(file);
      if (!data) {
        showToast('PNG 文件中未找到角色卡数据', 'error');
        return;
      }
    } else {
      // JSON character card
      const text = await file.text();
      try {
        data = JSON.parse(text);
      } catch {
        showToast('无效的 JSON 文件', 'error');
        return;
      }
    }

    if (data.data && typeof data.data === 'object') data = data.data;
    if (data.Character && typeof data.Character === 'object') data = data.Character;

    // Resolve avatar reference, recognizing SillyTavern markdown image links
    // (e.g. char_image: "![](https://...)" or "![alt](path)") in addition to
    // plain URLs / data URIs. Without this, the raw "![](...)" string is stored
    // verbatim and breaks <img src="..."> rendering.
    const resolvedAvatar = resolveCardAvatar(data);
    if (resolvedAvatar) {
      data.avatar = resolvedAvatar;
      delete data.char_image;
    } else {
      delete data.avatar;
      delete data.char_image;
    }

    // PNG file: send image + JSON separately via FormData to avoid base64 in DB
    if (file.name.toLowerCase().endsWith('.png')) {
      const hasExistingAvatar = data.avatar || data.char_image;
      const formData = new FormData();
      // Drop any base64 avatar from the card — we'll use the PNG file itself
      const cleanData = { ...data };
      if (!hasExistingAvatar) {
        delete cleanData.avatar;
        delete cleanData.char_image;
      }
      formData.append('json', JSON.stringify(cleanData));
      formData.append('image', file);
      await CharacterAPI.importFile(formData);
    } else {
      await CharacterAPI.import(data);
    }
    showToast('角色卡导入成功', 'success');

    AppState.characters = await CharacterAPI.list();
    renderStripAvatars();
    renderCharacterList();
  } catch (err) {
    console.error('[ImportCharacter] 失败:', err);
    showToast(`导入失败: ${err.message}`, 'error');
  }

  e.target.value = '';
}

async function fetchModels() {
  const url = DOM.providerUrl().value.trim();
  const apiKey = DOM.providerApiKey().value.trim();
  const providerType = DOM.providerType().value;
  const select = DOM.providerModelSelect();
  const input = DOM.providerModel();

  if (!url) { showToast('请先填写 API URL', 'warning'); return; }

  DOM.btnFetchModels().textContent = '获取中...';
  DOM.btnFetchModels().disabled = true;

  try {
    const models = await ProviderAPI.fetchModels(url, apiKey, providerType);
    if (!models || models.length === 0) {
      select.style.display = 'none';
      // For X.AI, models endpoint may not exist — suggest manual input
      const msg = providerType === 'xai'
        ? 'X.AI 不支持模型列表API，请手动输入模型名（如 grok-4.3）'
        : '未获取到模型，请检查 URL';
      showToast(msg, 'warning');
      return;
    }
    select.innerHTML = models.map(m => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join('');
    select.style.display = 'block';
    select.value = input.value || models[0];
    input.value = select.value;
    select.onchange = () => { input.value = select.value; };
    showToast('获取到 ' + models.length + ' 个模型', 'success');
  } catch (err) {
    const msg = err.message || '';
    if (msg.includes('502') || msg.includes('Bad Gateway') || msg.includes('Failed to fetch')) {
      showToast('获取失败: API 服务不可达，请检查服务是否已启动', 'error');
    } else {
      showToast('获取失败: ' + msg, 'error');
    }
  } finally {
    DOM.btnFetchModels().textContent = '获取模型';
    DOM.btnFetchModels().disabled = false;
  }
}

/**
 * Extract character JSON from SillyTavern PNG card (chara/ccv3 tEXt chunk).
 * Adapted from SillyTavern's reference implementation for correct UTF-8 handling.
 */
async function extractPNGCharacterData(file) {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);

  // Check PNG signature
  const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== PNG_SIG[i]) return null;
  }

  let offset = 8;
  while (offset < bytes.length) {
    const len = (bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3];
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);

    if (type === 'tEXt') {
      const dataStart = offset + 8;
      // Find null byte separating keyword from value
      let nullIdx = -1;
      for (let i = dataStart; i < dataStart + len; i++) {
        if (bytes[i] === 0) { nullIdx = i; break; }
      }
      if (nullIdx >= 0) {
        const kw = String.fromCharCode(...bytes.slice(dataStart, nullIdx));
        if (kw === 'chara' || kw === 'ccv3') {
          const b64Bytes = bytes.slice(nullIdx + 1, dataStart + len);
          // NOTE: never use String.fromCharCode(...b64Bytes) — for large cards
          // (>~1MB base64) the spread exceeds the JS engine's argument limit and
          // throws "Maximum call stack size exceeded". Assemble in chunks instead.
          const b64Str = decodeBytesToString(b64Bytes);
          try {
            // Decode base64 → binary bytes → UTF-8 JSON (correct handling)
            const binStr = atob(b64Str);
            const rawBytes = new Uint8Array(binStr.length);
            for (let i = 0; i < binStr.length; i++) rawBytes[i] = binStr.charCodeAt(i);
            const json = new TextDecoder().decode(rawBytes);
            return JSON.parse(json);
          } catch (e) {
            console.warn('[PNG] Failed to decode chara chunk:', e.message);
          }
        }
      }
    }

    offset += 12 + len;
  }

  return null;
}

/** Convert a File to a data URL string (for embedding PNG thumbnails as avatar) */
function fileToDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/** Extract first meaningful character from a name, skipping symbols like ()[]【】 etc */
function firstCharNoSymbol(name) {
  if (!name) return '?';
  const stripped = name.replace(/[\s()[\]【】《》〈〉「」『』{}<>·\-\+=\/\\|*&^%$#@!?~`"'',.;:]/g, '');
  return stripped.charAt(0) || name.charAt(0);
}

/**
 * Replace SillyTavern-style macros in text with current user/character names.
 * Supports: {{user}}, {{char}}, {{用户}}, {{角色}}
 * Called at render time so switching users immediately updates displayed text.
 */
function replaceMacros(text) {
  if (!text || typeof text !== 'string') return text;
  const userName = (AppState.userProfile && AppState.userProfile.name) || '我';
  const charName = (AppState.currentCharacter && AppState.currentCharacter.name) || '';
  return text
    .replace(/\{\{\s*user\s*\}\}/gi, userName)
    .replace(/\{\{\s*char\s*\}\}/gi, charName)
    .replace(/\{\{\s*用户\s*\}\}/g, userName)
    .replace(/\{\{\s*角色\s*\}\}/g, charName);
}

// ============ 供应商管理 ============

function renderProviderList() {
  const container = DOM.providerList();

  if (AppState.providers.length === 0) {
    container.innerHTML = '<div class="empty-hint">暂无供应商，请添加一个 API 供应商</div>';
    return;
  }

  container.innerHTML = AppState.providers.map(p => `
    <div class="provider-item ${p.is_default ? 'default' : ''}" data-id="${p.id}">
      <div class="provider-info">
        <div class="provider-name">
          ${escapeHtml(p.name)}
          ${p.is_default ? '<span class="badge">默认</span>' : ''}
        </div>
        <div class="provider-detail">${escapeHtml(p.provider_type)} · ${escapeHtml(p.model)}</div>
      </div>
      <div class="provider-actions">
        ${!p.is_default ? `<button class="icon-btn-sm provider-set-default" data-id="${p.id}" title="设为默认">★</button>` : ''}
        <button class="icon-btn-sm provider-edit" data-id="${p.id}" title="编辑">✎</button>
        <button class="icon-btn-sm provider-delete" data-id="${p.id}" title="删除">✕</button>
      </div>
    </div>
  `).join('');

  container.querySelectorAll('.provider-edit').forEach(btn => {
    btn.addEventListener('click', () => openProviderModal(btn.dataset.id));
  });

  container.querySelectorAll('.provider-delete').forEach(btn => {
    btn.addEventListener('click', () => deleteProvider(btn.dataset.id));
  });

  container.querySelectorAll('.provider-set-default').forEach(btn => {
    btn.addEventListener('click', async () => {
      try {
        await request('/providers/' + btn.dataset.id + '/set-default', { method: 'POST' });
        await loadInitialData();
        showToast('已设为默认供应商', 'success');
      } catch (err) {
        showToast('操作失败', 'error');
      }
    });
  });
}

function openProviderModal(providerId = null) {
  const modal = DOM.providerModal();
  const title = DOM.providerModalTitle();

  if (providerId) {
    AppState.editingProviderId = providerId;
    title.textContent = '编辑供应商';
    const p = AppState.providers.find(x => x.id === providerId);
    if (p) {
      DOM.providerName().value = p.name || '';
      DOM.providerType().value = p.provider_type || 'openai';
      DOM.providerUrl().value = p.base_url || '';
      // ⚠️ Never put the display mask (`••••••••`) into the input VALUE. Saving the form would then
      // send the mask back and overwrite the real key with it, leaving every request without an
      // Authorization header → 401 "Unauthorized". Show it as a placeholder instead: an untouched
      // field stays empty and is omitted from the save payload, so the stored key is preserved.
      const keyField = DOM.providerApiKey();
      keyField.value = '';
      keyField.placeholder = p.has_api_key ? '已保存密钥（留空则保持不变）' : 'sk-...';
      DOM.providerModel().value = p.model || '';
      DOM.providerHeaders().value = p.custom_headers ? (typeof p.custom_headers === 'string' ? p.custom_headers : JSON.stringify(p.custom_headers, null, 2)) : '';
      DOM.providerIsDefault().checked = !!p.is_default;
    }
  } else {
    AppState.editingProviderId = null;
    title.textContent = '添加供应商';
    DOM.providerForm().reset();
  }

  modal.classList.remove('hidden');
}

function closeProviderModal() {
  DOM.providerModal().classList.add('hidden');
  AppState.editingProviderId = null;
}

async function saveProvider() {
  const data = {
    name: DOM.providerName().value.trim(),
    provider_type: DOM.providerType().value,
    base_url: DOM.providerUrl().value.trim(),
    model: DOM.providerModel().value.trim(),
    is_default: DOM.providerIsDefault().checked,
    thinking: DOM.providerThinking().checked ? 1 : 0,
  };

  // Only send api_key when the user actually typed one.
  //   - left empty while editing → omit the field entirely → the backend keeps the stored key
  //     (an empty string would be read as "clear the key"; a mask would destroy it)
  //   - non-empty → the user pasted/typed a key, so send it
  // To DELETE a stored key use the explicit "清除密钥" action, not "leave the field blank".
  const typedKey = DOM.providerApiKey().value.trim();
  if (typedKey) data.api_key = typedKey;

  // Parse custom headers
  try {
    const hdrRaw = DOM.providerHeaders().value.trim();
    if (hdrRaw) data.custom_headers = JSON.parse(hdrRaw);
  } catch { /* ignore invalid JSON */ }

  if (!data.name || !data.base_url || !data.model) {
    showToast('请填写名称、URL 和模型', 'warning');
    return;
  }

  try {
    if (AppState.editingProviderId) {
      await ProviderAPI.update(AppState.editingProviderId, data);
      showToast('供应商已更新', 'success');
    } else {
      await ProviderAPI.create(data);
      showToast('供应商已添加', 'success');
    }

    closeProviderModal();
    AppState.providers = await ProviderAPI.list();
    renderProviderList();
  } catch (err) {
    console.error('[SaveProvider] 失败:', err);
    showToast(`保存失败: ${err.message}`, 'error');
  }
}

async function deleteProvider(providerId) {
  if (!confirm('确定要删除该供应商吗？')) return;

  try {
    await ProviderAPI.delete(providerId);
    showToast('供应商已删除', 'success');
    AppState.providers = await ProviderAPI.list();
    renderProviderList();
  } catch (err) {
    console.error('[DeleteProvider] 失败:', err);
    showToast('删除供应商失败', 'error');
  }
}

// ============ 主题设置 ============

function renderThemeSettings() {
  const container = DOM.themeSettings();
  const mode = document.body.getAttribute('theme-mode') || 'dark';
  const themeItems = [
    { key: '--bg-primary', label: '主背景色' },
    { key: '--bg-secondary', label: '弹窗/侧栏背景' },
    { key: '--bg-input', label: '输入框背景' },
    { key: '--text-primary', label: '主文字色' },
    { key: '--text-accent', label: '强调文字色' },
    { key: '--accent', label: '主强调色' },
    { key: '--border-color', label: '边框色' },
  ];

  // Get current mode's overrides
  const modeVars = (AppState.themeVars && AppState.themeVars[mode]) || {};

  container.innerHTML = themeItems.map(item => {
    // Priority: custom override > computed CSS value from body
    let currentVal = modeVars[item.key];
    if (!currentVal) {
      currentVal = getComputedStyle(document.body).getPropertyValue(item.key).trim() || '#000';
    }
    return `
      <div class="theme-item">
        <label>${item.label}</label>
        <div class="theme-control">
          <input type="color" class="theme-color-input" data-key="${item.key}" value="${toHex(currentVal)}">
          <span class="theme-color-value">${currentVal}</span>
        </div>
      </div>
    `;
  }).join('');

  container.querySelectorAll('.theme-color-input').forEach(input => {
    input.addEventListener('input', (e) => {
      const key = e.target.dataset.key;
      const value = e.target.value;
      e.target.nextElementSibling.textContent = value;
      // Live preview: set inline style (per-mode will be re-applied on mode switch)
      applySingleThemeVar(key, value);
    });

    input.addEventListener('change', async (e) => {
      const key = e.target.dataset.key;
      const value = e.target.value;
      const currentMode = document.body.getAttribute('theme-mode') || 'dark';

      // Save to per-mode overrides
      if (!AppState.themeVars[currentMode]) AppState.themeVars[currentMode] = {};
      AppState.themeVars[currentMode][key] = value;

      try {
        // Only send current mode's overrides + explicit mode
        await ThemeAPI.update({
          css_variables: AppState.themeVars[currentMode],
          mode: currentMode,
          is_custom: true
        });
        showToast('主题已更新', 'success');
      } catch (err) {
        showToast('保存主题失败', 'error');
      }
    });
  });
}

async function resetTheme() {
  try {
    const result = await ThemeAPI.reset();
    AppState.themeVars = result.css_variables;  // { dark: {}, light: {} }
    applyThemeVars();
    renderThemeSettings();
    showToast('已重置为默认蓝色主题', 'success');
  } catch (err) {
    showToast('重置主题失败', 'error');
  }
}

async function setDefaultTheme() {
  // 收集当前 body inline 自定义覆盖作为当前模式的默认主题
  const body = document.body;
  const currentMode = body.getAttribute('theme-mode') || 'dark';
  const vars = {};
  for (let i = 0; i < body.style.length; i++) {
    const key = body.style[i];
    if (key.startsWith('--')) {
      vars[key] = body.style.getPropertyValue(key).trim();
    }
  }
  if (Object.keys(vars).length === 0) {
    showToast('请先调整主题颜色', 'warning');
    return;
  }
  try {
    await ThemeAPI.update({ css_variables: vars, mode: currentMode, is_default: true });
    // 持久化到当前模式的覆盖值
    AppState.themeVars[currentMode] = { ...(AppState.themeVars[currentMode] || {}), ...vars };
    showToast('已设为默认主题（' + (currentMode === 'light' ? '亮色' : '暗色') + '），重启后生效', 'success');
  } catch (err) {
    showToast('保存失败', 'error');
  }
}

function applyThemeVars() {
  const body = document.body;
  // Clear all inline CSS variable overrides first (both html and body)
  document.documentElement.removeAttribute('style');
  body.removeAttribute('style');

  const mode = body.getAttribute('theme-mode') || 'dark';
  // Only apply CUSTOM overrides — defaults come from CSS cascade
  const overrides = (AppState.themeVars && AppState.themeVars[mode]) || {};

  Object.entries(overrides).forEach(([key, value]) => {
    if (value) body.style.setProperty(key, value);
  });
}

function applySingleThemeVar(key, value) {
  // MUST set on body, not html — because body[theme-mode] rules
  // set custom properties directly on body, which beat inherited values from html
  document.body.style.setProperty(key, value);
}

function switchThemeMode(mode) {
  if (!mode) mode = document.body.getAttribute('theme-mode') || 'dark';
  document.body.setAttribute('theme-mode', mode);
  localStorage.setItem('rp-theme-mode', mode);

  // Clear inline styles → CSS cascade handles defaults
  // Then apply custom overrides for the new mode
  applyThemeVars();

  // Re-render color pickers to reflect current mode
  renderThemeSettings();

  // Sync embedded XML web-views (iframe) to the new theme
  refreshEmbedThemes();
}

/** Toggle between dark/light mode (called by top-bar button) */
function toggleThemeMode() {
  const current = document.body.getAttribute('theme-mode') || 'dark';
  const next = current === 'dark' ? 'light' : 'dark';
  switchThemeMode(next);
}

function initThemeMode() {
  const saved = localStorage.getItem('rp-theme-mode') || 'dark';
  document.body.setAttribute('theme-mode', saved);
}

// ============ Theme Preset System ============

function initThemePreset() {
  const saved = localStorage.getItem('rp-theme-preset') || 'default';
  const sel = document.getElementById('themePresetSelect');
  if (sel) {
    sel.value = saved;
    applyThemePreset(saved);
  }
}

function applyThemePreset(preset) {
  const html = document.documentElement;
  if (preset && preset !== 'default') {
    html.setAttribute('data-theme', preset);
  } else {
    html.removeAttribute('data-theme');
  }
  // iOS theme works best in light mode; parchment and pink in dark by default
  if (preset === 'ios') {
    const current = document.body.getAttribute('theme-mode') || 'dark';
    if (current !== 'light') {
      switchThemeMode('light');
    }
  }
}

function switchThemePreset() {
  const sel = document.getElementById('themePresetSelect');
  if (!sel) return;
  const preset = sel.value;
  applyThemePreset(preset);
  localStorage.setItem('rp-theme-preset', preset);
}

function exportTheme() {
  const mode = document.body.getAttribute('theme-mode') || 'dark';
  const vars = {};
  const body = document.body;
  const keys = [
    '--bg-primary', '--bg-secondary', '--bg-tertiary', '--bg-card', '--bg-input',
    '--text-primary', '--text-secondary', '--text-muted', '--text-accent',
    '--border-color', '--border-accent', '--glass-border', '--glass-border-strong',
    '--glass-heavy', '--glass-mid', '--glass-bg-card', '--page-glow-a', '--page-glow-b'
  ];
  keys.forEach(k => {
    const val = getComputedStyle(body).getPropertyValue(k);
    if (val) vars[k] = val.trim();
  });

  // Export as per-mode structure
  const data = { [mode]: vars, _exported_mode: mode };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  const downloadUrl = URL.createObjectURL(blob);
  a.href = downloadUrl;
  a.download = 'theme-' + mode + '-' + new Date().toISOString().slice(0, 10) + '.json';
  a.click();
  URL.revokeObjectURL(downloadUrl);
  showToast('主题已导出（' + (mode === 'light' ? '亮色' : '暗色') + '）', 'success');
}

async function importTheme(e) {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    const currentMode = document.body.getAttribute('theme-mode') || 'dark';

    let modeOverrides = {};

    if (data.dark || data.light) {
      // Per-mode format: { dark: {...}, light: {...} }
      AppState.themeVars = { dark: data.dark || {}, light: data.light || {} };
      modeOverrides = AppState.themeVars[currentMode];
    } else {
      // Flat format: treat as current mode overrides
      AppState.themeVars[currentMode] = { ...(AppState.themeVars[currentMode] || {}), ...data };
      modeOverrides = data;
    }

    applyThemeVars();
    renderThemeSettings();

    // Save to backend (send current mode overrides with mode)
    await ThemeAPI.update({ css_variables: modeOverrides, mode: currentMode });
    showToast('主题已导入', 'success');
  } catch (err) {
    showToast('导入失败: 无效的主题文件', 'error');
  }
  e.target.value = '';
}

// ============ Markdown Table Renderer ============

// ============ API 预设管理 ============

async function openApiPresets() {
  DOM.apiPresetsModal().classList.remove('hidden');
  await loadChatPresets(null);
  renderImageGenSettings();
}

async function openApiPresetsWithPreset(presetId) {
  DOM.apiPresetsModal().classList.remove('hidden');
  await loadChatPresets(presetId);
  renderImageGenSettings();
}

function closeApiPresets() {
  DOM.apiPresetsModal().classList.add('hidden');
}

/**
 * Refresh preset options in the settings panel dropdowns (mainAIPreset, butlerAIPreset).
 * Keeps the currently selected values intact.
 */
async function refreshSettingsPresetOptions() {
  try {
    const presets = await PresetAPI.list();
    const optionsHTML = '<option value="">不使用预设</option>' +
      presets.map(p => `<option value="${p.id}">${escapeHtml(p.name || p.id)}</option>`).join('');

    ['mainAIPreset', 'butlerAIPreset'].forEach(selectId => {
      const sel = document.getElementById(selectId);
      if (!sel) return;
      const currentVal = sel.value;
      sel.innerHTML = optionsHTML;
      sel.value = currentVal;
    });
  } catch (e) { /* ignore */ }
}

/**
 * Load chat presets into the modal selector.
 * @param {string|null} autoSelectId - If provided, auto-select this preset ID instead of default
 */
async function loadChatPresets(autoSelectId) {
  try {
    const presets = await PresetAPI.list('chat');
    const sel = DOM.chatPresetSelect();
    sel.innerHTML = presets.map(p => `<option value="${p.id}">${escapeHtml(p.name)}${p.is_default ? ' (默认)' : ''}</option>`).join('');
    if (presets.length > 0) {
      // Auto-select specified ID, or fall back to default/first
      const toSelect = autoSelectId
        ? presets.find(p => p.id === autoSelectId) || presets.find(p => p.is_default) || presets[0]
        : presets.find(p => p.is_default) || presets[0];
      sel.value = toSelect.id;
      renderPresetParams();
    }
  } catch (err) { console.error('Load presets failed:', err); }
}

function renderPresetParams() {
  const selId = DOM.chatPresetSelect().value;
  if (!selId) return;
  PresetAPI.get(selId).then(preset => {
    const data = preset.data || {};
    const enabled = new Set(preset.enabled_params || []);
    const systemPrompts = data.system_prompts || [];
    const params = [
      { key: 'temperature', label: '温度 (Temperature)', min: 0, max: 2, step: 0.05 },
      { key: 'top_p', label: 'Top P', min: 0, max: 1, step: 0.01 },
      { key: 'top_k', label: 'Top K', min: 1, max: 200, step: 1 },
      { key: 'repetition_penalty', label: '重复惩罚 (Rep. Penalty)', min: 1, max: 2, step: 0.05 },
      { key: 'frequency_penalty', label: '频率惩罚 (Freq. Penalty)', min: 0, max: 2, step: 0.05 },
      { key: 'presence_penalty', label: '存在惩罚 (Pres. Penalty)', min: 0, max: 2, step: 0.05 },
      { key: 'max_tokens', label: '最大 Token 数', min: 64, max: 32768, step: 64 },
    ];

    const spRows = systemPrompts.map((sp, i) => `
      <div class="preset-sp-item" data-sp-index="${i}" style="border:1px solid var(--glass-border);border-radius:8px;padding:8px 10px;margin:4px 0">
        <div class="setting-row">
          <span class="sp-drag-handle" title="拖动排序" draggable="true" style="cursor:grab;color:var(--text-muted);font-size:14px;padding:0 2px;user-select:none">⋮⋮</span>
          <label class="toggle-switch">
            <input type="checkbox" class="preset-sp-toggle" data-sp-index="${i}" ${sp.enabled ? 'checked' : ''} ${sp.forbid_overrides ? 'disabled' : ''}>
            <span class="toggle-slider"></span>
          </label>
          <span style="flex:1">
            <span style="font-weight:600">${escapeHtml(sp.name || '提示词 ' + (i + 1))}</span>
            <span style="font-size:10px;color:var(--text-muted);margin-left:6px">${sp.role === 'assistant' ? '🤖' : sp.role === 'user' ? '👤' : '⚙'} pos:${sp.injection_position ?? 0} depth:${sp.injection_depth ?? 0}</span>
          </span>
          <span style="font-size:11px;color:var(--text-muted)">${(sp.content || '').length}字</span>
          <button class="btn btn-sm preset-sp-edit" data-sp-index="${i}" title="编辑">✎</button>
          <button class="btn btn-sm btn-danger preset-sp-delete" data-sp-index="${i}" title="删除" ${sp.forbid_overrides ? 'disabled' : ''}>✕</button>
        </div>
      </div>
    `).join('');

    // Init _spData from current system prompts (complete metadata)
    _spData.clear();
    systemPrompts.forEach((sp, i) => _spData.set(i, {
      name: sp.name || '', content: sp.content || '',
      role: sp.role || 'system', injection_position: sp.injection_position ?? 0,
      injection_depth: sp.injection_depth ?? 0, forbid_overrides: sp.forbid_overrides || false
    }));

    DOM.presetParams().innerHTML = `
      <div class="form-group">
        <label>预设名称</label>
        <input type="text" id="presetNameInput" class="setting-input" value="${escapeHtml(preset.name || '')}">
      </div>
      ${params.map(p => `
      <div class="setting-row">
        <label class="toggle-switch">
          <input type="checkbox" class="preset-toggle" data-key="${p.key}" ${enabled.has(p.key) ? 'checked' : ''}>
          <span class="toggle-slider"></span>
        </label>
        <span style="flex:1">${p.label}</span>
        <input type="number" class="setting-input preset-val" data-key="${p.key}" 
          value="${data[p.key] !== undefined ? data[p.key] : ''}" 
          min="${p.min}" max="${p.max}" step="${p.step}"
          style="width:90px" placeholder="${p.key === 'temperature' ? '0.8' : ''}">
      </div>
    `).join('')}
      <hr>
      <div class="form-group">
        <label>系统提示词 (${systemPrompts.length} 条)</label>
        <div id="spList">${spRows || '<p style="color:var(--text-muted);font-size:12px">（导入 ST 预设时自动提取，或手动添加）</p>'}</div>
        <button class="btn btn-sm" id="btnAddSystemPrompt" style="margin-top:6px">+ 添加提示词</button>
      </div>
      <button class="btn btn-sm" id="btnSavePreset" style="margin-top:10px">💾 保存预设</button>
      <span id="presetSaveStatus" style="margin-left:10px;font-size:12px;color:var(--text-muted)"></span>
    `;

    // Save button
    DOM.presetParams().querySelector('#btnSavePreset').addEventListener('click', async () => {
      const name = DOM.presetParams().querySelector('#presetNameInput').value.trim();
      const newData = {};
      const newEnabled = [];
      DOM.presetParams().querySelectorAll('.preset-val').forEach(inp => {
        const val = parseFloat(inp.value);
        if (!isNaN(val)) newData[inp.dataset.key] = val;
      });
      DOM.presetParams().querySelectorAll('.preset-toggle').forEach(cb => {
        if (cb.checked) newEnabled.push(cb.dataset.key);
      });

      // Collect system prompts (preserve metadata from _spData + toggle from DOM)
      const newSPs = [];
      DOM.presetParams().querySelectorAll('.preset-sp-item').forEach(el => {
        const idx = parseInt(el.dataset.spIndex);
        const toggle = el.querySelector('.preset-sp-toggle');
        const stored = _spData.get(idx) || { name: '', content: '', role: 'system', injection_position: 0, injection_depth: 0, forbid_overrides: false };
        newSPs.push({
          name: stored.name,
          content: stored.content,
          role: stored.role || 'system',
          enabled: toggle ? (toggle.disabled ? stored.enabled : toggle.checked) : stored.enabled,
          injection_position: stored.injection_position ?? 0,
          injection_depth: stored.injection_depth ?? 0,
          forbid_overrides: stored.forbid_overrides || false
        });
      });
      newData.system_prompts = newSPs;

      try {
        await PresetAPI.save(selId, { name, data: newData, enabled_params: newEnabled });
        DOM.presetParams().querySelector('#presetSaveStatus').textContent = '已保存 ✓';
        const sel = DOM.chatPresetSelect();
        const opt = sel.querySelector(`option[value="${selId}"]`);
        if (opt) opt.textContent = name + ' ✓';
        // Refresh settings panel dropdowns (both mainAI and butlerAI)
        await refreshSettingsPresetOptions();
        setTimeout(() => {
          const st = DOM.presetParams().querySelector('#presetSaveStatus');
          if (st) st.textContent = '';
        }, 2000);
      } catch (err) {
        DOM.presetParams().querySelector('#presetSaveStatus').textContent = '保存失败';
      }
    });

    // Add system prompt button — opens slide panel
    DOM.presetParams().querySelector('#btnAddSystemPrompt').addEventListener('click', () => {
      _spEditTarget = null;  // null = new entry
      openSpEditor();
    });

    // Edit buttons
    DOM.presetParams().querySelectorAll('.preset-sp-edit').forEach(btn => {
      btn.addEventListener('click', () => {
        _spEditTarget = parseInt(btn.dataset.spIndex);
        openSpEditor();
      });
    });

    // Delete buttons
    DOM.presetParams().querySelectorAll('.preset-sp-delete').forEach(btn => {
      btn.addEventListener('click', () => {
        btn.closest('.preset-sp-item').remove();
        rebuildSpDataFromDOM();
        reindexSpItems();
        markUnsaved();
      });
    });

    // Live feedback
    DOM.presetParams().querySelectorAll('.preset-toggle, .preset-val, #presetNameInput, .preset-sp-toggle').forEach(el => {
      el.addEventListener('change', markUnsaved);
      if (el.tagName === 'INPUT' && (el.type === 'number' || el.type === 'text')) el.addEventListener('input', markUnsaved);
    });

    // Visual feedback: dim/brighten SP items when toggled
    DOM.presetParams().querySelectorAll('.preset-sp-toggle').forEach(toggle => {
      const item = toggle.closest('.preset-sp-item');
      if (item) {
        // Set initial visual state
        if (!toggle.checked && !toggle.disabled) item.style.opacity = '0.5';
        toggle.addEventListener('change', () => {
          item.style.opacity = toggle.checked ? '1' : '0.5';
        });
      }
    });

    // === Drag-and-drop reordering for system prompt items ===
    let _dragSrcIndex = null;

    // Drag initiation on the drag handle
    DOM.presetParams().querySelectorAll('.sp-drag-handle').forEach(handle => {
      handle.addEventListener('dragstart', (e) => {
        const item = handle.closest('.preset-sp-item');
        if (!item) return;
        _dragSrcIndex = parseInt(item.dataset.spIndex);
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', String(_dragSrcIndex));
        item.style.opacity = '0.4';
        item.style.borderStyle = 'dashed';
      });

      handle.addEventListener('dragend', () => {
        const item = handle.closest('.preset-sp-item');
        if (item) {
          item.style.opacity = '';
          item.style.borderStyle = '';
        }
        // Clear all drop hints
        DOM.presetParams().querySelectorAll('.preset-sp-item').forEach(el => {
          el.style.borderTop = '';
          el.style.marginTop = '';
        });
      });
    });

    // Drop targets: each preset-sp-item
    DOM.presetParams().querySelectorAll('.preset-sp-item').forEach(item => {
      item.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const rect = item.getBoundingClientRect();
        const midY = rect.top + rect.height / 2;
        const insertAbove = e.clientY < midY;
        DOM.presetParams().querySelectorAll('.preset-sp-item').forEach(el => { el.style.borderTop = ''; el.style.marginTop = ''; });
        if (insertAbove) {
          item.style.borderTop = '2px solid var(--color-accent-500)';
          item.style.marginTop = '4px';
        }
      });

      item.addEventListener('dragleave', () => {
        item.style.borderTop = '';
        item.style.marginTop = '';
      });

      item.addEventListener('drop', (e) => {
        e.preventDefault();
        item.style.borderTop = '';
        item.style.marginTop = '';

        const srcIdx = parseInt(e.dataTransfer.getData('text/plain'));
        if (isNaN(srcIdx)) return;

        const container = document.getElementById('spList');
        if (!container) return;

        const srcItem = container.querySelector(`.preset-sp-item[data-sp-index="${srcIdx}"]`);
        if (!srcItem || srcItem === item) return;

        const rect = item.getBoundingClientRect();
        const midY = rect.top + rect.height / 2;
        if (e.clientY < midY) {
          container.insertBefore(srcItem, item);
        } else {
          const next = item.nextSibling;
          if (next) {
            container.insertBefore(srcItem, next);
          } else {
            container.appendChild(srcItem);
          }
        }

        // Rebuild _spData from old indices first, then update data-sp-index
        rebuildSpDataFromDOM();
        reindexSpItems();
        markUnsaved();
      });
    });

    // Prevent drag on interactive elements inside items (but allow on the drag handle itself)
    DOM.presetParams().querySelectorAll('.preset-sp-toggle, .preset-sp-edit, .preset-sp-delete, .toggle-switch').forEach(el => {
      el.addEventListener('dragstart', (e) => e.preventDefault());
    });
  }).catch(console.error);
}

async function importSTPreset(e) {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const stData = JSON.parse(text);
    const parsed = parseSTPresetData(stData, file.name);
    const id = 'st-' + Date.now();
    await PresetAPI.save(id, {
      name: parsed.name,
      preset_type: 'chat',
      data: parsed.data,
      enabled_params: parsed.enabled_params,
      imported_from: file.name
    });
    showToast('ST 预设已导入: ' + parsed.name + ' (参数' + parsed.paramCount + '项, 提示词' + parsed.promptCount + '条)', 'success');
    await loadChatPresets(id);
  } catch (err) {
    showToast('导入失败: ' + (err.message || '无效文件'), 'error');
  }
  e.target.value = '';
}

/**
 * Export the selected chat preset as a **standard SillyTavern chat completion
 * preset** (format details in server/st-preset.js), embedding the active API
 * provider's source / URL / model so the file can be imported into SillyTavern
 * directly.
 *
 * API keys are deliberately never written into the file: ST keeps credentials in
 * its own secrets store and a preset is meant to be shareable.
 */
async function exportSTPreset() {
  const sel = DOM.chatPresetSelect();
  const id = sel ? sel.value : '';
  if (!id) { showToast('请先选择一个预设', 'warning'); return; }

  // Gather name + mapping report for feedback. Neither is allowed to block the
  // actual download, so each failure is tolerated independently.
  let name = 'preset';
  let note = '';
  try {
    const preset = await PresetAPI.get(id);
    if (preset && preset.name) name = preset.name;
  } catch (err) { console.warn('[ST export] name lookup failed:', err); }

  try {
    const { report } = await PresetAPI.exportStMeta(id);
    console.log('[ST export] mapping report:', report);
    if (report && Array.isArray(report.unmappableSkipped) && report.unmappableSkipped.length > 0) {
      note = '；' + report.unmappableSkipped.join('、') + ' 在 ST 聊天补全预设中无对应字段，已跳过';
    }
    if (report && report.source) {
      note += '；供应商映射为 ST 源「' + report.source + '」';
    }
  } catch (err) { console.warn('[ST export] report unavailable:', err); }

  const safe = String(name).replace(/[\\/:*?"<>|]+/g, '_').trim() || 'preset';
  const a = document.createElement('a');
  a.href = PresetAPI.exportStUrl(id);
  a.download = safe + '.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  showToast('已导出 ST 格式预设（API Key 不含在内）' + note, 'success');
}

async function setChatPresetDefault() {
  const id = DOM.chatPresetSelect().value;
  if (!id) return;
  await PresetAPI.setDefault(id);
  showToast('已设为默认预设', 'success');
  await loadChatPresets(id);
}

async function deleteChatPreset() {
  const id = DOM.chatPresetSelect().value;
  if (!id || id === 'default') { showToast('不能删除默认预设', 'warning'); return; }
  if (!confirm('确定删除此预设？')) return;
  await PresetAPI.delete(id);
  showToast('预设已删除', 'success');
  await loadChatPresets(null);
}

// ============ 系统提示词滑出编辑器 ============

function markUnsaved() {
  const st = document.querySelector('#presetSaveStatus');
  if (st) st.textContent = '未保存';
}
function reindexSpItems() {
  const container = document.querySelector('#presetParams');
  if (!container) return;
  container.querySelectorAll('.preset-sp-item').forEach((el, i) => {
    el.dataset.spIndex = i;
    el.querySelectorAll('[data-sp-index]').forEach(c => c.dataset.spIndex = i);
  });
}

/**
 * Rebuild _spData Map from current DOM order (BEFORE reindexSpItems is called).
 * Called after drag-reorder so _spData indices match visual order.
 * Relies on items still having their old data-sp-index values to look up _spData.
 */
function rebuildSpDataFromDOM() {
  const container = document.querySelector('#presetParams');
  if (!container) return;
  const newMap = new Map();
  let newIdx = 0;
  container.querySelectorAll('.preset-sp-item').forEach(el => {
    const oldIdx = parseInt(el.dataset.spIndex);
    newMap.set(newIdx, _spData.get(oldIdx) || { name: '', content: '', role: 'system', injection_position: 0, injection_depth: 0, forbid_overrides: false });
    newIdx++;
  });
  _spData = newMap;
}

let _spEditTarget = null;
let _spData = new Map();
let _editPresetSource = null;  // 'mainAIPreset' | 'butlerAIPreset' — which settings dropdown opened the editor

function openSpEditor() {
  DOM.spEditorPanel().classList.remove('hidden');
  if (_spEditTarget !== null) {
    const data = _spData.get(_spEditTarget) || { name: '', content: '' };
    DOM.spEditorTitle().textContent = '编辑: ' + (data.name || '提示词');
    DOM.spEditorName().value = data.name || '';
    DOM.spEditorContent().value = data.content || '';
  } else {
    DOM.spEditorTitle().textContent = '新建系统提示词';
    DOM.spEditorName().value = '';
    DOM.spEditorContent().value = '';
  }
  DOM.spEditorName().focus();
}

function closeSpEditor() {
  DOM.spEditorPanel().classList.add('hidden');
}

function saveSpFromPanel() {
  const name = DOM.spEditorName().value.trim() || '系统提示词';
  const content = DOM.spEditorContent().value;

  if (_spEditTarget !== null) {
    const old = _spData.get(_spEditTarget) || {};
    _spData.set(_spEditTarget, { ...old, name, content });
    const item = DOM.presetParams().querySelector(`.preset-sp-item[data-sp-index="${_spEditTarget}"]`);
    if (item) {
      // Update the name span (first <span> with font-weight:600 inside the item)
      const nameSpan = item.querySelector('span[style*="font-weight:600"]') || item.querySelector('span[style*="font-weight"]');
      if (nameSpan) nameSpan.textContent = name;
      // Update the character count span
      const charCountSpans = item.querySelectorAll('.setting-row > span');
      const charSpan = Array.from(charCountSpans).find(s => s.textContent.includes('字') && !s.querySelector('span'));
      if (charSpan) charSpan.textContent = content.length + '字';
    }
  } else {
    const idx = DOM.presetParams().querySelectorAll('.preset-sp-item').length;
    _spData.set(idx, { name, content, role: 'system', injection_position: 0, injection_depth: 0, forbid_overrides: false });
    const div = document.createElement('div');
    div.className = 'preset-sp-item';
    div.dataset.spIndex = idx;
    div.style.cssText = 'border:1px solid var(--glass-border);border-radius:8px;padding:8px 10px;margin:4px 0';
    div.innerHTML = `
      <div class="setting-row">
        <label class="toggle-switch">
          <input type="checkbox" class="preset-sp-toggle" data-sp-index="${idx}" checked>
          <span class="toggle-slider"></span>
        </label>
        <span style="flex:1;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(name)}</span>
        <span style="font-size:11px;color:var(--text-muted)">${content.length}字</span>
        <button class="btn btn-sm preset-sp-edit" data-sp-index="${idx}" title="编辑">✎</button>
        <button class="btn btn-sm btn-danger preset-sp-delete" data-sp-index="${idx}" title="删除">✕</button>
      </div>`;
    DOM.presetParams().querySelector('#spList').appendChild(div);
    div.querySelector('.preset-sp-edit').addEventListener('click', () => { _spEditTarget = idx; openSpEditor(); });
    div.querySelector('.preset-sp-delete').addEventListener('click', () => { div.remove(); reindexSpItems(); markUnsaved(); });
    div.querySelector('.preset-sp-toggle').addEventListener('change', markUnsaved);
  }
  markUnsaved();
  closeSpEditor();
}

// ============ 图像生成设置 ============

// ============ 生图引擎（默认 anima-turbo-cg） ============
// anima-turbo-cg 是默认的极简本地生图引擎（stable-diffusion.cpp，OpenAI 兼容，端口 8100）。
// 权威默认值在服务端 server/constants.js 的 ANIMA_PRESET；这里是前端在字段为空时的展示回退。
const ANIMA_DEFAULTS = {
  api_url: 'http://127.0.0.1:8100/v1/images/generations',
  api_key: 'local',
  api_model: 'sd-cpp-local',
  image_size: '1024x1024',
};
// 需要「API 地址 / Key / 模型」这一组字段的引擎
const API_IMAGE_MODES = ['anima', 'openai', 'stability'];
const hasApiEndpoint = (m) => API_IMAGE_MODES.includes(m);
const hasComfyGroup = (m) => m === 'comfyui' || m === 'none';

/**
 * 计算要展示/保存的 API 字段。anima 引擎自带默认端点，即使数据库里是空的也能开箱即用。
 */
function effectiveApiSettings(s) {
  const src = s || {};
  const isAnima = (src.mode || 'anima') === 'anima';
  const pick = (v, fb) => ((typeof v === 'string' && v.trim()) ? v.trim() : (isAnima ? fb : ''));
  return {
    api_url: pick(src.api_url, ANIMA_DEFAULTS.api_url),
    api_key: pick(src.api_key, ANIMA_DEFAULTS.api_key),
    api_model: pick(src.api_model, ANIMA_DEFAULTS.api_model),
    image_size: (src.image_size || (isAnima ? ANIMA_DEFAULTS.image_size : '')),
  };
}

function imageOpenAISettingsHtml(rawSettings) {
  // 生成「生图模型 + 提示词质量前缀 + 图片尺寸」三块控件 HTML
  // （OpenAI / Stability / anima-turbo-cg 三种模式共用，都是 API 端点式引擎）
  // anima-turbo-cg 的模型/尺寸有内置默认值，字段为空时也要显示出来（否则用户面对空白下拉框）
  const eff = effectiveApiSettings(rawSettings);
  const s = Object.assign({}, rawSettings, { api_model: eff.api_model, image_size: eff.image_size });
  const m = (s.api_model || '').trim();
  const q = s.quality_prefix || '';
  const sz = s.image_size || '';
  // 尺寸选项：空=不指定（由服务商用各自默认值）；下列覆盖 DALL-E 与 SenseNova u1 的合法尺寸
  const sizeOpts = [
    '', '1024x1024', '1792x1024', '1024x1792',
    '2048x2048', '1536x2752', '2752x1536', '1664x2496', '2496x1664',
    '1760x2368', '2368x1760', '1824x2272', '2272x1824', '1344x3136', '3072x1376'
  ];
  const sizeLabels = { '': '服务商默认（不指定尺寸）' };
  const qOpts = [
    ['', '无（不添加）'],
    ['high quality, detailed, sharp focus', '标准增强'],
    ['photorealistic, highly detailed, 8k uhd, raw photo', '写实摄影'],
    ['anime style, masterpiece, highly detailed, vibrant colors', '动漫插画'],
    ['oil painting, artistic, detailed brushwork', '油画艺术'],
  ];
  const esc = (v) => escapeHtml(v);
  const selFixed = (val, opts) => opts.map(o => `<option value="${esc(o)}" ${o === val ? 'selected' : ''}>${esc(o)}</option>`).join('');
  const selMap = (val, opts) => opts.map(([v, t]) => `<option value="${esc(v)}" ${v === val ? 'selected' : ''}>${esc(t)}</option>`).join('');
  // 生图模型：默认不写死任何模型（避免过时默认值），由用户点击「拉取」从服务端获取；
  // 仅保留当前已保存的模型值与「自定义...」入口
  const modelOptions = [];
  if (m) modelOptions.push(`<option value="${esc(m)}" selected>${esc(m)}</option>`);
  modelOptions.push(`<option value="__custom__" ${m ? '' : 'selected'}>自定义...</option>`);
  const showModelCustom = !m;
  const sizeCustom = !sizeOpts.includes(sz);
  const qCustom = !qOpts.some(([v]) => v === q);
  const sizeOptions = sizeOpts.map(o => `<option value="${esc(o)}" ${o === sz ? 'selected' : ''}>${esc(sizeLabels[o] || o)}</option>`).join('');
  return `
    <label style="margin-top:8px;display:block">生图模型</label>
    <div style="display:flex;gap:6px;align-items:center">
      <select id="apiModel" class="setting-select" style="flex:1;min-width:0">
        ${modelOptions.join('')}
      </select>
      <button type="button" id="fetchImageModels" class="btn btn-sm" title="从服务器拉取模型列表">拉取</button>
    </div>
    <input type="text" id="apiModelCustom" class="setting-input" style="display:${showModelCustom ? 'block' : 'none'};margin-top:4px" placeholder="自定义模型名，如 gpt-image-1" value="${esc(showModelCustom ? m : '')}">
    <div id="apiModelHint" class="setting-hint" style="display:none;color:#d98b00;font-size:12px;margin-top:4px"></div>

    <label style="margin-top:8px;display:block">提示词质量前缀</label>
    <select id="qualityPrefix" class="setting-select">
      ${selMap(q, qOpts)}
      <option value="__custom__" ${qCustom ? 'selected' : ''}>自定义...</option>
    </select>
    <input type="text" id="qualityPrefixCustom" class="setting-input" style="display:${qCustom ? 'block' : 'none'};margin-top:4px" placeholder="自定义质量前缀（会拼接到提示词最前）" value="${esc(qCustom ? q : '')}">

    <label style="margin-top:8px;display:block">图片尺寸</label>
    <select id="imageSize" class="setting-select">
      ${sizeOptions}
      <option value="__custom__" ${sizeCustom ? 'selected' : ''}>自定义...</option>
    </select>
    <input type="text" id="imageSizeCustom" class="setting-input" style="display:${sizeCustom ? 'block' : 'none'};margin-top:4px" placeholder="自定义尺寸，如 1536x1024（须为服务商支持的尺寸）" value="${esc(sizeCustom ? sz : '')}">
  `;
}

// 为自定义（__custom__）选项绑定显示/隐藏，并对尺寸自定义做同样处理
function wireOpenAICustom(root) {
  const pairs = [['#apiModel', '#apiModelCustom'], ['#qualityPrefix', '#qualityPrefixCustom'], ['#imageSize', '#imageSizeCustom']];
  for (const [sel, inp] of pairs) {
    const s = root.querySelector(sel);
    const i = root.querySelector(inp);
    if (s && i) {
      s.addEventListener('change', () => { i.style.display = (s.value === '__custom__') ? 'block' : 'none'; });
    }
  }
  const fb = root.querySelector('#fetchImageModels');
  if (fb) fb.addEventListener('click', () => fetchImageModelsInto(root));
}

// 从服务端 /models 接口拉取模型列表并填充当前 UI 的模型下拉框
// 注意：OpenAI 兼容的 /models 通常返回全部模型（含聊天模型），并不区分生图能力，
// 因此这里做启发式分类：把明显是「聊天/语言模型」的名称标注「可能非生图」并后置，
// 其余（含真正的生图模型，如 sensenova-u1-fast、dall-e-3、gpt-image-1）作为候选置顶。
const CHAT_MODEL_RE = /chat|llm|deepseek|glm|qwen|claude|llama|gpt-3|gpt-4|gpt-5|grok|gemini|mistral|mixtral|ernie|abab|minimax|moonshot|kimi|baichuan|chatglm|flash-lite|\bflash\b|\blite\b|instruct|reason|turbo|\bmini\b/i;
function isLikelyChatModel(name) { return CHAT_MODEL_RE.test(name || ''); }

function fetchImageModelsInto(root) {
  const btn = root.querySelector('#fetchImageModels');
  if (!btn) return;
  const orig = btn.textContent;
  btn.disabled = true; btn.textContent = '拉取中…';
  const hintEl = root.querySelector('#apiModelHint');
  if (hintEl) hintEl.style.display = 'none';
  (async () => {
    try {
      const apiUrlEl = root.querySelector('#apiUrl') || root.querySelector('#imageApiUrl');
      const apiKeyEl = root.querySelector('#apiKey') || root.querySelector('#imageApiKey');
      const api_url = apiUrlEl ? apiUrlEl.value.trim() : '';
      const api_key = apiKeyEl ? apiKeyEl.value.trim() : '';
      if (!api_url) { showToast('请先填写 API 地址', 'warning'); return; }
      const resp = await fetch('/api/images/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_url, api_key })
      });
      const j = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(j.error || ('HTTP ' + resp.status));
      const models = Array.isArray(j.models) ? j.models : [];
      if (!models.length) { showToast('服务器未返回可用模型', 'warning'); return; }
      // 把聊天模型标注并后置，其余（含真正的生图模型）作为候选置顶
      const chatModels = models.filter(isLikelyChatModel);
      const candidateModels = models.filter(m => !isLikelyChatModel(m));
      const ordered = candidateModels.concat(chatModels);
      const sel = root.querySelector('#apiModel');
      const customInput = root.querySelector('#apiModelCustom');
      const current = sel.value === '__custom__' ? (customInput ? customInput.value.trim() : '') : sel.value;
      sel.innerHTML = '';
      for (const id of ordered) {
        const o = document.createElement('option');
        o.value = id;
        o.textContent = isLikelyChatModel(id) ? (id + '（可能非生图）') : id;
        if (id === current) o.selected = true;
        sel.appendChild(o);
      }
      // 保留当前已保存但不在列表中的值
      if (current && !models.includes(current)) {
        const o = document.createElement('option');
        o.value = current; o.textContent = current + '（当前）'; o.selected = true;
        sel.appendChild(o);
      }
      const co = document.createElement('option');
      co.value = '__custom__'; co.textContent = '自定义...';
      sel.appendChild(co);
      if (candidateModels.length === 0) {
        const msg = '返回的全是聊天模型，未检测到生图模型。请选「自定义...」并手动填写服务商文档里的生图模型名。';
        showToast(msg, 'warning');
        if (hintEl) { hintEl.textContent = msg; hintEl.style.display = 'block'; }
      } else {
        showToast('已拉取 ' + models.length + ' 个模型' + (chatModels.length ? ('（' + chatModels.length + ' 个聊天模型已标注并后置）') : ''), 'success');
      }
    } catch (e) {
      showToast('拉取模型失败：' + e.message, 'error');
    } finally {
      btn.disabled = false; btn.textContent = orig;
    }
  })();
}

// 从控件中解析出最终要保存的值
function resolveOpenAIValues(root) {
  const pick = (sel, inp) => {
    const s = root.querySelector(sel);
    const i = root.querySelector(inp);
    if (!s) return '';
    if (s.value === '__custom__') return (i ? i.value.trim() : '');
    return s.value;
  };
  return {
    api_model: pick('#apiModel', '#apiModelCustom'),
    quality_prefix: pick('#qualityPrefix', '#qualityPrefixCustom'),
    image_size: pick('#imageSize', '#imageSizeCustom'),
  };
}

// Generation params editor removed (built-in Anima engine uninstalled).

function renderImageGenSettings() {
  ImageAPI.get().then(s => {
    const mode = s.mode || 'anima';
    const eff = effectiveApiSettings(Object.assign({}, s, { mode }));
    DOM.imageGenSettings().innerHTML = `
      <div class="form-group">
        <label>生成引擎</label>
        <select id="genMode" class="setting-select">
          <option value="anima" ${mode === 'anima' ? 'selected' : ''}>anima-turbo-cg（极简本地生图·默认）</option>
          <option value="comfyui" ${mode === 'comfyui' ? 'selected' : ''}>ComfyUI（画质最佳·需工作流）</option>
          <option value="openai" ${mode === 'openai' ? 'selected' : ''}>OpenAI DALL-E / 兼容 API</option>
          <option value="stability" ${mode === 'stability' ? 'selected' : ''}>Stability AI</option>
          <option value="none" ${mode === 'none' ? 'selected' : ''}>关闭生图</option>
        </select>
        <small style="color:var(--text-muted)">默认走 anima-turbo-cg（极简模式，需另启该服务，见 README）。追求更好画质请选 ComfyUI 并配置工作流。</small>
      </div>
      <div class="form-group">
        <label>提示词模式</label>
        <select id="genPromptMode" class="setting-select">
          <option value="tag" ${(s.gen_mode || 'tag') === 'tag' ? 'selected' : ''}>关键词Tag模式</option>
          <option value="natural" ${s.gen_mode === 'natural' ? 'selected' : ''}>自然语言模式</option>
        </select>
      </div>
      <div class="form-group" id="comfyuiGroup" style="display:${hasComfyGroup(mode) ? 'block' : 'none'}">
        <label>ComfyUI 地址</label>
        <input type="text" id="comfyuiUrl" class="setting-input" value="${escapeHtml(s.comfyui_url || 'http://127.0.0.1:8188')}">
      </div>
      <div class="form-group" id="apiGroup" style="display:${hasApiEndpoint(mode) ? 'block' : 'none'}">
        <label>API 地址</label>
        <input type="text" id="apiUrl" class="setting-input" value="${escapeHtml(eff.api_url)}" placeholder="https://api.openai.com/v1/images/generations">
        <label style="margin-top:6px">API Key</label>
        <input type="password" id="apiKey" class="setting-input" value="${escapeHtml(eff.api_key)}">
        ${imageOpenAISettingsHtml(Object.assign({}, s, { mode }))}
      </div>
      <button class="btn btn-sm" id="btnSaveImageGenSettings" style="margin-top:8px">保存图像设置</button>
    `;

    DOM.imageGenSettings().querySelector('#genMode').addEventListener('change', (e) => {
      const v = e.target.value;
      DOM.imageGenSettings().querySelector('#comfyuiGroup').style.display = hasComfyGroup(v) ? 'block' : 'none';
      DOM.imageGenSettings().querySelector('#apiGroup').style.display = hasApiEndpoint(v) ? 'block' : 'none';
      prefillApiFieldsForMode(DOM.imageGenSettings(), v);
    });
    wireOpenAICustom(DOM.imageGenSettings());

    DOM.imageGenSettings().querySelector('#btnSaveImageGenSettings').addEventListener('click', async () => {
      const mode = DOM.imageGenSettings().querySelector('#genMode').value;
      const genMode = DOM.imageGenSettings().querySelector('#genPromptMode').value;
      const data = { mode, gen_mode: genMode };
      if (hasComfyGroup(mode)) {
        data.comfyui_url = DOM.imageGenSettings().querySelector('#comfyuiUrl').value;
      } else {
        data.api_url = DOM.imageGenSettings().querySelector('#apiUrl').value;
        data.api_key = DOM.imageGenSettings().querySelector('#apiKey').value;
        Object.assign(data, resolveOpenAIValues(DOM.imageGenSettings()));
      }
      try {
        await ImageAPI.update(data);
        showToast('图像设置已保存', 'success');
      } catch (err) {
        showToast('保存失败', 'error');
      }
    });
  }).catch(console.error);
}

/**
 * 切到 anima-turbo-cg 时，把内置默认端点写进空字段，避免用户看到空白的 URL/模型/尺寸。
 * 已有内容（用户自己填过的）一律不覆盖。
 */
function prefillApiFieldsForMode(root, mode) {
  if (!root || mode !== 'anima') return;
  const url = root.querySelector('#apiUrl') || root.querySelector('#imageApiUrl');
  const key = root.querySelector('#apiKey') || root.querySelector('#imageApiKey');
  const modelSel = root.querySelector('#apiModel');
  const modelCustom = root.querySelector('#apiModelCustom');
  const sizeSel = root.querySelector('#imageSize');
  const sizeCustom = root.querySelector('#imageSizeCustom');
  if (url && !url.value.trim()) url.value = ANIMA_DEFAULTS.api_url;
  if (key && !key.value.trim()) key.value = ANIMA_DEFAULTS.api_key;
  if (modelSel && modelCustom) {
    const current = modelSel.value === '__custom__' ? modelCustom.value.trim() : modelSel.value;
    if (!current) { modelSel.value = '__custom__'; modelCustom.value = ANIMA_DEFAULTS.api_model; modelCustom.style.display = 'block'; }
  }
  if (sizeSel && sizeCustom) {
    const current = sizeSel.value === '__custom__' ? sizeCustom.value.trim() : sizeSel.value;
    if (!current) { sizeSel.value = ANIMA_DEFAULTS.image_size; sizeCustom.style.display = 'none'; }
  }
}

// ============ BGM 播放器 ============

const BGM_STATE = { enabled: false, currentMood: '', audioEl: null, isPlaying: false };

function toggleBGM() {
  BGM_STATE.enabled = !BGM_STATE.enabled;
  DOM.audioIcon().textContent = BGM_STATE.enabled ? '🔊' : '🔇';
  DOM.btnToggleAudio().classList.toggle('active', BGM_STATE.enabled);
  if (BGM_STATE.enabled) {
    // Start default music
    if (!BGM_STATE.isPlaying) playBGM('nomal');
    // 播放没真的起来（没有 BGM 文件 / 被拦截）→ 开关回退为关闭，保持一致
    setTimeout(() => {
      if (!BGM_STATE.enabled) return; // 期间又被手动切过，别打架
      const el = BGM_STATE.audioEl;
      const playing = !!(el && !el.paused && !el.ended);
      BGM_STATE.isPlaying = playing;
      if (!playing) {
        BGM_STATE.enabled = false;
        DOM.audioIcon().textContent = '🔇';
        DOM.btnToggleAudio().classList.remove('active');
        localStorage.setItem('rp-bgm-enabled', '0');
        console.log('[BGM] 未能开始播放 — 开关回退为关闭');
      }
    }, 1500);
  } else {
    if (BGM_STATE.audioEl) { BGM_STATE.audioEl.pause(); BGM_STATE.isPlaying = false; }
  }
  localStorage.setItem('rp-bgm-enabled', BGM_STATE.enabled ? '1' : '0');
}

const MOOD_FOLDERS = {
  battle: 'battle', blue: 'blue', ceremony: 'ceremony',
  relaxed: 'relaxed', nomal: 'nomal', suspense: 'suspense'
};

function playBGM(mood) {
  if (!BGM_STATE.enabled) return;
  // Don't switch BGM while TTS is playing
  if (window._ttsPlaying) return;
  if (!mood) { mood = 'nomal'; }
  mood = mood.toLowerCase().trim();

  // Same mood, already playing → do nothing
  if (mood === BGM_STATE.currentMood && BGM_STATE.isPlaying && BGM_STATE.audioEl && !BGM_STATE.audioEl.paused) return;

  // Same mood, but audio stopped → just resume
  if (mood === BGM_STATE.currentMood && BGM_STATE.audioEl && BGM_STATE.audioEl.paused && BGM_STATE.audioEl.src) {
    BGM_STATE.audioEl.play().then(() => { BGM_STATE.isPlaying = true; }).catch(() => { });
    return;
  }

  const prevMood = BGM_STATE.currentMood;

  fetch('/bgm/')
    .then(r => r.json())
    .then(files => {
      const folderFiles = files[mood] || [];
      if (folderFiles.length === 0) {
        console.log('[BGM] No files for mood:', mood, '— keeping current music');
        // Don't switch: revert currentMood so the old track keeps its identity
        BGM_STATE.currentMood = prevMood;
        return;
      }
      const picked = folderFiles[Math.floor(Math.random() * folderFiles.length)];
      const src = '/bgm/' + encodeURIComponent(mood) + '/' + encodeURIComponent(picked);

      if (!BGM_STATE.audioEl) {
        BGM_STATE.audioEl = new Audio();
        BGM_STATE.audioEl.loop = true;
        // Safety net: if loop fails, replay on ended
        BGM_STATE.audioEl.addEventListener('ended', () => {
          if (BGM_STATE.enabled && BGM_STATE.audioEl) {
            BGM_STATE.audioEl.currentTime = 0;
            BGM_STATE.audioEl.play().catch(() => { });
          }
        });
      }
      BGM_STATE.audioEl.pause();
      BGM_STATE.audioEl.src = src;
      BGM_STATE.audioEl.loop = true;
      BGM_STATE.audioEl.volume = parseFloat(document.getElementById('bgmVolume')?.value || 30) / 100;
      BGM_STATE.audioEl.load();

      BGM_STATE.currentMood = mood;
      localStorage.setItem('rp-bgm-mood', mood);

      BGM_STATE.audioEl.play().then(() => {
        BGM_STATE.isPlaying = true;
        console.log('[BGM] Playing:', picked, 'mood:', mood);
      }).catch(e => console.log('[BGM] Play error:', e.message));
    })
    .catch(e => console.log('[BGM] Fetch error:', e.message));
}

function initBGM() {
  // 开关只反映【真实播放状态】：浏览器自动播放策略下，页面没有用户手势时 play() 会被拒绝。
  // 以前这里在尝试播放之前就把图标点亮成 🔊 / active，于是「实际没有声音、开关却显示开启」，
  // 必须点一下才恢复。现在：播放真的起来了才点亮；被拦截就如实显示关闭
  // （用户的偏好在 localStorage 里保留，第一次点击即可正常开启播放）。
  const setBgmUI = (on) => {
    BGM_STATE.enabled = !!on;
    const ic = DOM.audioIcon(); if (ic) ic.textContent = on ? '🔊' : '🔇';
    const bt = DOM.btnToggleAudio(); if (bt) bt.classList.toggle('active', !!on);
  };
  const saved = localStorage.getItem('rp-bgm-enabled');
  if (saved === '1') {
    BGM_STATE.enabled = true; // 仅作为「本次是否尝试播放」的意图，不代表开关状态
    // Restore last mood or use default
    const savedMood = localStorage.getItem('rp-bgm-mood') || 'nomal';
    setTimeout(() => {
      playBGM(savedMood);
      // playBGM 是异步的：稍后核对真实状态，没播起来就把开关如实置为关闭
      setTimeout(() => {
        const el = BGM_STATE.audioEl;
        const playing = !!(el && !el.paused && !el.ended);
        BGM_STATE.isPlaying = playing;
        setBgmUI(playing);
        if (!playing) {
          console.log('[BGM] 自动播放被浏览器拦截（页面尚无用户手势）— 开关如实显示为关闭，点一下即可播放');
        }
      }, 900);
    }, 500);
  } else {
    setBgmUI(false);
  }
  // Volume slider
  const volSlider = document.getElementById('bgmVolume');
  if (volSlider) {
    volSlider.value = localStorage.getItem('rp-bgm-volume') || 30;
    volSlider.addEventListener('input', () => {
      if (BGM_STATE.audioEl) BGM_STATE.audioEl.volume = volSlider.value / 100;
      localStorage.setItem('rp-bgm-volume', volSlider.value);
    });
  }
}

// Hook into message rendering to detect mood

// Open image gen settings via multimedia bar
function openImageGenSettingsInPanel() {
  // Show image gen settings in a simple popup
  const existing = document.getElementById('imageSettingsPopup');
  if (existing) { existing.remove(); return; }

  const popup = document.createElement('div');
  popup.id = 'imageSettingsPopup';
  popup.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:400;background:var(--glass-bg-card);border:1px solid var(--glass-border-strong);border-radius:12px;padding:16px;max-width:480px;width:90vw;backdrop-filter:blur(24px);box-shadow:0 16px 48px rgba(0,0,0,0.6)';
  popup.innerHTML = '<h4 style="margin-bottom:10px">图像生成设置</h4><div id="imageSettingsContent"></div><button class="btn btn-sm" style="margin-top:8px" onclick="document.getElementById(\'imageSettingsPopup\').remove()">关闭</button>';
  document.body.appendChild(popup);

  ImageAPI.get().then(s => {
    const div = popup.querySelector('#imageSettingsContent');
    const mode = s.mode || 'anima';
    const eff = effectiveApiSettings(Object.assign({}, s, { mode }));
    div.innerHTML = `
      <div class="form-group"><label>生成引擎</label>
        <select id="genMode" class="setting-select">
          <option value="anima" ${mode === 'anima' ? 'selected' : ''}>anima-turbo-cg（极简·默认）</option>
          <option value="comfyui" ${mode === 'comfyui' ? 'selected' : ''}>ComfyUI（画质最佳）</option>
          <option value="openai" ${mode === 'openai' ? 'selected' : ''}>OpenAI</option>
          <option value="stability" ${mode === 'stability' ? 'selected' : ''}>Stability</option>
          <option value="none" ${mode === 'none' ? 'selected' : ''}>关闭</option>
        </select></div>
      <div class="form-group"><label>提示词模式</label>
        <select id="genPromptMode" class="setting-select">
          <option value="tag" ${(s.gen_mode || 'tag') === 'tag' ? 'selected' : ''}>关键词Tag模式</option>
          <option value="natural" ${s.gen_mode === 'natural' ? 'selected' : ''}>自然语言模式</option>
        </select></div>
      <div class="form-group" id="comfyuiGroup" style="display:${hasComfyGroup(mode) ? 'block' : 'none'}">
        <label>ComfyUI 地址</label>
        <input type="text" id="comfyuiUrl" class="setting-input" value="${escapeHtml(s.comfyui_url || 'http://127.0.0.1:8188')}"></div>
      <div class="form-group" id="apiGroup" style="display:${hasApiEndpoint(mode) ? 'block' : 'none'}">
        <label>API 地址/Key</label>
        <input type="text" id="apiUrl" class="setting-input" value="${escapeHtml(eff.api_url)}" placeholder="API URL">
        <input type="password" id="apiKey" class="setting-input" value="${escapeHtml(eff.api_key)}" placeholder="API Key" style="margin-top:4px">
        ${imageOpenAISettingsHtml(Object.assign({}, s, { mode }))}</div>
      <button class="btn btn-sm" id="btnSaveImgPopup" style="margin-top:8px">保存</button>`;

    div.querySelector('#genMode').addEventListener('change', e => {
      div.querySelector('#comfyuiGroup').style.display = hasComfyGroup(e.target.value) ? 'block' : 'none';
      div.querySelector('#apiGroup').style.display = hasApiEndpoint(e.target.value) ? 'block' : 'none';
      prefillApiFieldsForMode(div, e.target.value);
    });
    wireOpenAICustom(div);
    div.querySelector('#btnSaveImgPopup').addEventListener('click', async () => {
      const m = div.querySelector('#genMode').value;
      const gm = div.querySelector('#genPromptMode').value;
      const d = { mode: m, gen_mode: gm };
      if (hasComfyGroup(m)) d.comfyui_url = div.querySelector('#comfyuiUrl').value;
      else { d.api_url = div.querySelector('#apiUrl').value; d.api_key = div.querySelector('#apiKey').value; Object.assign(d, resolveOpenAIValues(div)); }
      try { await ImageAPI.update(d); showToast('图像设置已保存', 'success'); popup.remove(); }
      catch { showToast('保存失败', 'error'); }
    });
  });
}

// ============ 记忆表格查看 ============

function renderMemoryAgentSettings() {
  // Just bind the event log viewer button
  const btn = document.getElementById('btnViewEventLog');
  if (btn) {
    btn.addEventListener('click', () => {
      const preview = document.getElementById('eventLogPreview');
      if (preview.style.display === 'none' || !preview.style.display) {
        preview.style.display = 'block';
        loadEventLog();
      } else {
        preview.style.display = 'none';
      }
    });
  }
}

function bindMemoryAgentEvents() {
  const debouncedSave = debounce(async () => {
    const data = {
      enabled: document.getElementById('memoryEnabled')?.checked ? 1 : 0,
      trigger_interval: parseInt(document.getElementById('memoryInterval')?.value) || 10,
      provider_id: document.getElementById('memoryProvider')?.value || '',
      prompt_template: document.getElementById('memoryPrompt')?.value || '',
    };
    try {
      await MemoryAgentAPI.update(data);
    } catch (err) {
      console.error('[MemoryAgent] 保存失败:', err);
    }
  }, 500);

  ['memoryEnabled', 'memoryInterval', 'memoryProvider', 'memoryPrompt'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', debouncedSave);
  });
  const promptEl = document.getElementById('memoryPrompt');
  if (promptEl) promptEl.addEventListener('input', debouncedSave);

  // Event log view/edit
  const btnView = document.getElementById('btnViewEventLog');
  const btnEdit = document.getElementById('btnEditEventLog');
  const btnSave = document.getElementById('btnSaveEventLog');
  const btnCancel = document.getElementById('btnCancelEditEventLog');

  if (btnView) btnView.addEventListener('click', async () => {
    const cid = AppState.currentConversation?.id;
    if (!cid) { showToast('请先选择一个对话', 'warning'); return; }
    try {
      const data = await MemoryAgentAPI.getEventLog(cid);
      const panel = document.getElementById('eventLogPreview');
      const content = document.getElementById('eventLogContent');
      const countdown = document.getElementById('eventLogCountdown');
      panel.style.display = 'block';
      content.textContent = data.log || '（暂无记忆记录）';
      if (data.log) content.style.display = 'block';
      countdown.textContent = `第 ${data.round} 轮，${data.countdown === 0 ? '已注入' : '再过 ' + data.countdown + ' 轮注入正文'}`;
      // Store for edit
      content.dataset.rawLog = data.log || '';
    } catch { showToast('读取失败', 'error'); }
  });

  if (btnEdit) btnEdit.addEventListener('click', () => {
    const content = document.getElementById('eventLogContent');
    const editor = document.getElementById('eventLogEditor');
    editor.value = content.dataset.rawLog || content.textContent || '';
    content.style.display = 'none';
    editor.style.display = 'block';
    btnEdit.style.display = 'none';
    btnSave.style.display = 'inline-block';
    btnCancel.style.display = 'inline-block';
  });

  if (btnSave) btnSave.addEventListener('click', async () => {
    const cid = AppState.currentConversation?.id;
    const editor = document.getElementById('eventLogEditor');
    try {
      await MemoryAgentAPI.saveEventLog(cid, editor.value);
      const content = document.getElementById('eventLogContent');
      content.textContent = editor.value;
      content.dataset.rawLog = editor.value;
      content.style.display = 'block';
      editor.style.display = 'none';
      btnEdit.style.display = 'inline-block';
      btnSave.style.display = 'none';
      btnCancel.style.display = 'none';
      showToast('记忆表格已保存', 'success');
    } catch { showToast('保存失败', 'error'); }
  });

  if (btnCancel) btnCancel.addEventListener('click', () => {
    const content = document.getElementById('eventLogContent');
    const editor = document.getElementById('eventLogEditor');
    content.style.display = 'block';
    editor.style.display = 'none';
    btnEdit.style.display = 'inline-block';
    btnSave.style.display = 'none';
    btnCancel.style.display = 'none';
  });
}

// ============ 图像生成设置 ============

function renderImageSettings() {
  const container = DOM.imageSettings();

  ImageAPI.get().then(settings => {
    const s = settings || {};
    const mode = s.mode || 'anima';
    const genMode = s.gen_mode || 'tag';
    const eff = effectiveApiSettings(Object.assign({}, s, { mode }));
    container.innerHTML = `
      <div class="setting-row" style="flex-direction:column;align-items:flex-start">
        <label>生成引擎</label>
        <select id="imageMode" class="setting-select">
          <option value="anima" ${mode === 'anima' ? 'selected' : ''}>anima-turbo-cg（极简本地生图·默认）</option>
          <option value="comfyui" ${mode === 'comfyui' ? 'selected' : ''}>ComfyUI（画质最佳·需工作流）</option>
          <option value="openai" ${mode === 'openai' ? 'selected' : ''}>OpenAI DALL-E / 兼容 API</option>
          <option value="stability" ${mode === 'stability' ? 'selected' : ''}>Stability AI</option>
          <option value="none" ${mode === 'none' ? 'selected' : ''}>关闭生图</option>
        </select>
        <small style="color:var(--text-muted)">默认 anima-turbo-cg：极简模式，解压即用、无 Python/ComfyUI（需先启动该服务，见 README）。想要更好的图像质量，请改装 ComfyUI 并配置工作流。</small>
      </div>
      <div class="setting-row" style="flex-direction:column;align-items:flex-start">
        <label>提示词模式</label>
        <select id="imageGenMode" class="setting-select">
          <option value="tag" ${genMode === 'tag' ? 'selected' : ''}>关键词Tag模式（标签拼凑）</option>
          <option value="natural" ${genMode === 'natural' ? 'selected' : ''}>自然语言模式（完整描述）</option>
        </select>
        <small style="color:var(--text-muted)">Tag模式：主AI和管家AI以标签组织生图提示词；自然语言模式：以完整句子描述场景</small>
      </div>
      <div id="imageComfyuiGroup" style="display:${hasComfyGroup(mode) ? 'block' : 'none'}">
        <div class="setting-row" style="flex-direction:column;align-items:flex-start">
          <label>ComfyUI 服务器地址</label>
          <input type="text" id="imageComfyuiUrl" value="${escapeHtml(s.comfyui_url || 'http://127.0.0.1:8188')}" class="setting-input" style="width:100%" placeholder="http://127.0.0.1:8188">
          <small style="color:var(--text-muted)">用于角色头像和CG生成</small>
        </div>
      </div>
      <div id="imageApiGroup" style="display:${hasApiEndpoint(mode) ? 'block' : 'none'}">
        <div class="setting-row" style="flex-direction:column;align-items:flex-start">
          <label>API 地址</label>
          <input type="text" id="imageApiUrl" value="${escapeHtml(eff.api_url)}" class="setting-input" style="width:100%" placeholder="https://api.openai.com/v1/images/generations">
        </div>
        <div class="setting-row" style="flex-direction:column;align-items:flex-start">
          <label>API Key</label>
          <input type="password" id="imageApiKey" value="${escapeHtml(eff.api_key)}" class="setting-input" style="width:100%" placeholder="anima-turbo-cg 填 local 即可">
        </div>
        ${imageOpenAISettingsHtml(Object.assign({}, s, { mode }))}
      </div>

      <hr style="border-color:var(--glass-border);margin:16px 0">
      <h5 style="margin:0 0 8px 0;color:var(--text-accent)">🎨 质量前缀设置（含艺术家信息）</h5>
      <div class="setting-row" style="flex-direction:column;align-items:flex-start">
        <label>头像质量前缀</label>
        <input type="text" id="imagePortraitQualityPrefix" value="${escapeHtml(s.portrait_quality_prefix || '')}" class="setting-input" style="width:100%" placeholder="留空使用默认: {artist:kousaki_ruri},+[artist:wlop]...">
        <small style="color:var(--text-muted)">头像生成时使用的固定质量前缀（含艺术家信息），每项逗号分隔</small>
      </div>
      <div class="setting-row" style="flex-direction:column;align-items:flex-start">
        <label>CG质量前缀</label>
        <input type="text" id="imageCGQualityPrefix" value="${escapeHtml(s.cg_quality_prefix || '')}" class="setting-input" style="width:100%" placeholder="留空使用默认: {artist:kousaki_ruri}, {artist:ciloranko}...">
        <small style="color:var(--text-muted)">CG场景生成时使用的固定质量前缀，每项逗号分隔</small>
      </div>

      <hr style="border-color:var(--glass-border);margin:16px 0">
      <h5 style="margin:0 0 8px 0;color:var(--text-accent)">🧩 工作流文件</h5>
      <small style="color:var(--text-muted);display:block;margin-bottom:8px">切换不同模型使用的工作流 JSON（放在项目根目录，如 my_workflow.json）。提示词节点会自动探测，无需手动填节点 ID</small>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
        <div class="setting-row" style="flex-direction:column;align-items:flex-start">
          <label>CG 工作流文件</label>
          <input type="text" id="imageCGWorkflow" value="${escapeHtml(s.cg_workflow || '')}" class="setting-input" style="width:100%" placeholder="留空=GALCG.json">
        </div>
        <div class="setting-row" style="flex-direction:column;align-items:flex-start">
          <label>头像工作流文件</label>
          <input type="text" id="imagePortraitWorkflow" value="${escapeHtml(s.portrait_workflow || '')}" class="setting-input" style="width:100%" placeholder="留空=portrait_x.json">
        </div>
      </div>

      <hr style="border-color:var(--glass-border);margin:16px 0">
      <h5 style="margin:0 0 8px 0;color:var(--text-accent)">🔧 工作流节点ID设置（可选覆盖）</h5>
      <small style="color:var(--text-muted);display:block;margin-bottom:8px">留空=自动探测：从工作流图结构自动识别正向/负向提示词节点，适配任意模型工作流。仅当自动探测选错节点时才需手动指定</small>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
        <div class="setting-row" style="flex-direction:column;align-items:flex-start">
          <label>头像→ 正向提示词节点ID</label>
          <input type="text" id="imagePortraitPositiveNode" value="${escapeHtml(s.portrait_positive_node || '')}" class="setting-input" style="width:100%" placeholder="留空=自动探测">
        </div>
        <div class="setting-row" style="flex-direction:column;align-items:flex-start">
          <label>头像→ 负向提示词节点ID</label>
          <input type="text" id="imagePortraitNegativeNode" value="${escapeHtml(s.portrait_negative_node || '')}" class="setting-input" style="width:100%" placeholder="留空=自动探测">
        </div>
        <div class="setting-row" style="flex-direction:column;align-items:flex-start">
          <label>CG→ 正向提示词节点ID</label>
          <input type="text" id="imageCGPositiveNode" value="${escapeHtml(s.cg_positive_node || '')}" class="setting-input" style="width:100%" placeholder="留空=自动探测">
        </div>
        <div class="setting-row" style="flex-direction:column;align-items:flex-start">
          <label>CG→ 负向提示词节点ID</label>
          <input type="text" id="imageCGNegativeNode" value="${escapeHtml(s.cg_negative_node || '')}" class="setting-input" style="width:100%" placeholder="留空=自动探测">
        </div>
      </div>

      <hr style="border-color:var(--glass-border);margin:16px 0">
      <h5 style="margin:0 0 8px 0;color:var(--text-accent)">🚫 负向提示词设置</h5>
      <small style="color:var(--text-muted);display:block;margin-bottom:8px">自定义负向提示词。留空则使用原工作流中的默认负向提示词</small>
      <div class="setting-row" style="flex-direction:column;align-items:flex-start">
        <label>头像负向提示词</label>
        <textarea id="imagePortraitNegativePrompt" class="setting-textarea" style="width:100%;min-height:80px" placeholder="留空使用工作流默认负向提示词">${escapeHtml(s.portrait_negative_prompt || '')}</textarea>
      </div>
      <div class="setting-row" style="flex-direction:column;align-items:flex-start">
        <label>CG负向提示词</label>
        <textarea id="imageCGNegativePrompt" class="setting-textarea" style="width:100%;min-height:80px" placeholder="留空使用工作流默认负向提示词">${escapeHtml(s.cg_negative_prompt || '')}</textarea>
      </div>

      <div style="margin-top:8px">
        <button class="btn btn-sm btn-primary" id="btnSaveImageSettings">保存图像设置</button>
      </div>
    `;

    // 引擎模式切换时显示/隐藏对应设置
    const modeSelect = document.getElementById('imageMode');
    if (modeSelect) {
      modeSelect.addEventListener('change', () => {
        const v = modeSelect.value;
        const comfyuiGroup = document.getElementById('imageComfyuiGroup');
        const apiGroup = document.getElementById('imageApiGroup');
        if (comfyuiGroup) comfyuiGroup.style.display = hasComfyGroup(v) ? 'block' : 'none';
        if (apiGroup) apiGroup.style.display = hasApiEndpoint(v) ? 'block' : 'none';
        prefillApiFieldsForMode(container, v);
      });
    }
    wireOpenAICustom(container);

    // 保存按钮
    const saveBtn = document.getElementById('btnSaveImageSettings');
    if (saveBtn) {
      saveBtn.addEventListener('click', async () => {
        try {
          const m = document.getElementById('imageMode')?.value || 'anima';
          const g = document.getElementById('imageGenMode')?.value || 'tag';
          const data = {
            mode: m,
            gen_mode: g,
            portrait_quality_prefix: document.getElementById('imagePortraitQualityPrefix')?.value || '',
            cg_quality_prefix: document.getElementById('imageCGQualityPrefix')?.value || '',
            portrait_positive_node: document.getElementById('imagePortraitPositiveNode')?.value || '',
            portrait_negative_node: document.getElementById('imagePortraitNegativeNode')?.value || '',
            cg_positive_node: document.getElementById('imageCGPositiveNode')?.value || '',
            cg_negative_node: document.getElementById('imageCGNegativeNode')?.value || '',
            portrait_negative_prompt: document.getElementById('imagePortraitNegativePrompt')?.value || '',
            cg_negative_prompt: document.getElementById('imageCGNegativePrompt')?.value || '',
            cg_workflow: document.getElementById('imageCGWorkflow')?.value.trim() || '',
            portrait_workflow: document.getElementById('imagePortraitWorkflow')?.value.trim() || '',
          };
          if (hasComfyGroup(m)) {
            data.comfyui_url = document.getElementById('imageComfyuiUrl')?.value || 'http://127.0.0.1:8188';
          } else {
            data.api_url = document.getElementById('imageApiUrl')?.value || '';
            data.api_key = document.getElementById('imageApiKey')?.value || '';
            Object.assign(data, resolveOpenAIValues(container));
          }
          await ImageAPI.update(data);
          showToast('图像设置已保存', 'success');
        } catch (err) {
          showToast('保存失败: ' + err.message, 'error');
        }
      });
    }
  }).catch(() => {
    container.innerHTML = '<div class="empty-hint">加载失败</div>';
  });
}

async function saveImageSettings() {
  try {
    const mode = document.getElementById('imageMode')?.value || 'anima';
    const genMode = document.getElementById('imageGenMode')?.value || 'tag';
    const data = {
      mode,
      gen_mode: genMode,
      portrait_quality_prefix: document.getElementById('imagePortraitQualityPrefix')?.value || '',
      cg_quality_prefix: document.getElementById('imageCGQualityPrefix')?.value || '',
      portrait_positive_node: document.getElementById('imagePortraitPositiveNode')?.value || '',
      portrait_negative_node: document.getElementById('imagePortraitNegativeNode')?.value || '',
      cg_positive_node: document.getElementById('imageCGPositiveNode')?.value || '',
      cg_negative_node: document.getElementById('imageCGNegativeNode')?.value || '',
      portrait_negative_prompt: document.getElementById('imagePortraitNegativePrompt')?.value || '',
      cg_negative_prompt: document.getElementById('imageCGNegativePrompt')?.value || '',
      cg_workflow: document.getElementById('imageCGWorkflow')?.value.trim() || '',
      portrait_workflow: document.getElementById('imagePortraitWorkflow')?.value.trim() || '',
    };
    if (hasComfyGroup(mode)) {
      data.comfyui_url = document.getElementById('imageComfyuiUrl')?.value || 'http://127.0.0.1:8188';
    } else {
      data.api_url = document.getElementById('imageApiUrl')?.value || '';
      data.api_key = document.getElementById('imageApiKey')?.value || '';
      Object.assign(data, resolveOpenAIValues(document));
    }
    await ImageAPI.update(data);
  } catch { /* ignore */ }
}

// ============ 斜杠指令处理 ============

/**
 * 处理斜杠指令，返回 true 表示已处理（不发送给AI）
 * 支持：
 *   /hide 1-10     隐藏第1到10轮对话的AI上下文
 *   /hide 3,5,7    隐藏第3、5、7轮
 *   /hide 5        隐藏第5轮
 *   /unhide 1-10   恢复第1到10轮
 *   /restart        重启对话（可选删除记录）
 *   /export         导出对话
 */
function handleSlashCommand(content) {
  const parts = content.trim().split(/\s+/);
  const cmd = parts[0].toLowerCase();

  switch (cmd) {
    case '/hide':
      return handleHideCommand(parts.slice(1), true);
    case '/unhide':
      return handleHideCommand(parts.slice(1), false);
    case '/restart':
      restartConversation();
      return true;
    case '/export':
      exportConversation();
      return true;
    default:
      // 非 app 内置指令：交给 STScript 引擎处理（未知命令由引擎提示）
      return false;
  }
}

/**
 * 解析楼层范围字符串，返回楼层号数组
 * 支持: "1-10", "3,5,7", "5", "1-3,7,9-11"
 */
function parseRoundRanges(args) {
  const rounds = new Set();

  for (const arg of args) {
    const segments = arg.split(',');
    for (const seg of segments) {
      const trimmed = seg.trim();
      if (!trimmed) continue;

      if (trimmed.includes('-')) {
        const [startStr, endStr] = trimmed.split('-');
        const start = parseInt(startStr);
        const end = parseInt(endStr);
        if (isNaN(start) || isNaN(end)) continue;
        for (let i = Math.min(start, end); i <= Math.max(start, end); i++) {
          if (i > 0) rounds.add(i);
        }
      } else {
        const num = parseInt(trimmed);
        if (!isNaN(num) && num > 0) rounds.add(num);
      }
    }
  }

  return [...rounds].sort((a, b) => a - b);
}

/**
 * 处理 /hide 和 /unhide 指令
 */
async function handleHideCommand(args, hide) {
  if (args.length === 0) {
    showToast('用法: /hide 1-10 或 /hide 3,5,7', 'warning');
    return true;
  }

  const targetRounds = parseRoundRanges(args);
  if (targetRounds.length === 0) {
    showToast('无法解析楼层范围', 'warning');
    return true;
  }

  // 找出对应楼层的消息 ID
  const messageIds = [];
  let roundNum = 0;

  for (const msg of AppState.messages) {
    if (msg.role === 'user') roundNum++;
    if (targetRounds.includes(roundNum)) {
      // 隐藏整轮：user + assistant
      messageIds.push(msg.id);
    }
  }

  if (messageIds.length === 0) {
    showToast('未找到对应楼层的消息', 'warning');
    return true;
  }

  // 过滤掉临时 ID
  const realIds = messageIds.filter(id => !id.startsWith('temp-') && !id.startsWith('stream-'));
  if (realIds.length === 0) {
    showToast('这些楼层尚未同步到服务器', 'warning');
    return true;
  }

  try {
    await MessageAPI.batchHide(realIds, hide);
    showToast(`${hide ? '已隐藏' : '已恢复'}第 ${targetRounds.join(',')} 轮的AI上下文`, 'success');

    // 更新本地消息状态和 UI
    realIds.forEach(id => {
      const msg = AppState.messages.find(m => m.id === id);
      if (msg) msg.hidden = hide ? 1 : 0;

      const el = DOM.messagesArea().querySelector(`[data-id="${id}"]`);
      if (el) {
        if (hide) {
          el.classList.add('is-hidden');
        } else {
          el.classList.remove('is-hidden');
        }
        // 重新渲染该元素
        const round = parseInt(el.dataset.round) || 0;
        const msgObj = AppState.messages.find(m => m.id === id);
        if (msgObj) {
          el.className = `story-block ${msgObj.role}${hide ? ' is-hidden' : ''}`;
          let formatted = null;
          try { formatted = typeof msgObj.formatted === 'string' ? JSON.parse(msgObj.formatted) : msgObj.formatted; } catch { /* ignore */ }
          if (msgObj.role === 'user') {
            el.innerHTML = renderUserBlock(msgObj.content, msgObj.created_at, round, hide);
          } else {
            el.innerHTML = renderAIBlock(formatted, msgObj.content, msgObj.created_at, hide);
          }
        }
      }
    });
  } catch (err) {
    console.error('[HideCommand] 失败:', err);
    showToast(`操作失败: ${err.message}`, 'error');
  }

  return true;
}

// ============ 重启对话 ============

async function restartConversation() {
  if (!AppState.currentConversation) {
    showToast('当前没有活跃的对话', 'warning');
    return;
  }

  // 弹出选择框
  const choice = await showRestartDialog();
  if (!choice) return; // 取消

  try {
    if (choice === 'delete') {
      // 删除整个对话，重新创建
      const charId = AppState.currentConversation.character_id;
      await ConversationAPI.delete(AppState.currentConversation.id);

      AppState.currentConversation = null;
      AppState.messages = [];
      AppState.totalMessages = 0;
      AppState._messagesFullyLoaded = false;
      renderLoadEarlierBar();
      AppState.roundCounter = 0;
      AppState.userStatus = {};
      AppState.galleryImages = [];
      AppState.galleryIndex = 0;
      AppState.cgGallery = [];
      AppState._currentSaveId = '';
      clearDebugPanel();

      // 重新创建对话
      if (charId && AppState.currentCharacter) {
        const result = await ConversationAPI.create({
          character_id: charId,
        });
        await loadConversation(result.id);
        showToast('对话已重置（记录已删除）', 'success');
      }
    } else if (choice === 'clear') {
      // 保留对话，仅清空消息
      await ConversationAPI.clearMessages(AppState.currentConversation.id);
      AppState.messages = [];
      AppState.totalMessages = 0;
      AppState._messagesFullyLoaded = false;
      renderLoadEarlierBar();
      AppState.roundCounter = 0;
      AppState.galleryImages = [];
      AppState.galleryIndex = 0;
      // 重开 = 回到「初次加载」的样子：本局的 CG 记录一并清掉，
      // 否则旧 CG 会继续霸占背景，要等又生成一张新 CG 才换掉。
      // 只清画廊索引，图片文件保留在存档目录里（不删盘上文件）。
      const sid = getCurrentSaveId();
      if (sid) await request('/saves/' + sid + '/cg-gallery', { method: 'DELETE' }).catch(() => {});
      AppState.cgGallery = [];
      clearDebugPanel();
      DOM.messagesArea().innerHTML = '';
      renderGallery();
      showToast('对话已重启（保留对话框架）', 'success');
    }
  } catch (err) {
    console.error('[Restart] 失败:', err);
    showToast(`重启失败: ${err.message}`, 'error');
  }
}

/**
 * 显示重启对话框，返回 'delete' | 'clear' | null(取消)
 */
function showRestartDialog() {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.style.zIndex = '10001';
    overlay.style.display = 'flex';
    overlay.style.alignItems = 'center';
    overlay.style.justifyContent = 'center';

    overlay.innerHTML = `
      <div class="restart-dialog">
        <h3>重启对话</h3>
        <p>选择重启方式：</p>
        <div class="restart-options">
          <button class="btn btn-primary restart-btn" data-choice="clear">仅清空消息</button>
          <p class="restart-hint">保留对话框架，清空所有消息</p>
        </div>
        <div class="restart-options">
          <button class="btn restart-btn" data-choice="delete" style="color: #DC143C; border-color: #DC143C;">删除并重建</button>
          <p class="restart-hint">删除当前对话记录，创建新对话</p>
        </div>
        <div class="restart-actions">
          <button class="btn restart-cancel-btn">取消</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    overlay.querySelector('[data-choice="clear"]').addEventListener('click', () => {
      overlay.remove();
      resolve('clear');
    });
    overlay.querySelector('[data-choice="delete"]').addEventListener('click', () => {
      overlay.remove();
      resolve('delete');
    });
    overlay.querySelector('.restart-cancel-btn').addEventListener('click', () => {
      overlay.remove();
      resolve(null);
    });
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        overlay.remove();
        resolve(null);
      }
    });
  });
}

// ============ 导出对话 ============

async function exportConversation() {
  if (!AppState.currentConversation) {
    showToast('当前没有活跃的对话', 'warning');
    return;
  }

  const choice = await showExportDialog();
  if (!choice) return;

  try {
    await ConversationAPI.export(AppState.currentConversation.id, choice);
    showToast(`导出成功（${choice === 'summary' ? '主窗口内容' : '完整内容'}）`, 'success');
  } catch (err) {
    console.error('[Export] 失败:', err);
    showToast(`导出失败: ${err.message}`, 'error');
  }
}

/**
 * 显示导出选择对话框
 */
function showExportDialog() {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.style.zIndex = '10001';
    overlay.style.display = 'flex';
    overlay.style.alignItems = 'center';
    overlay.style.justifyContent = 'center';

    overlay.innerHTML = `
      <div class="restart-dialog">
        <h3>导出对话</h3>
        <p>选择导出格式：</p>
        <div class="restart-options">
          <button class="btn btn-primary restart-btn" data-choice="summary">主窗口内容</button>
          <p class="restart-hint">仅包含旁白和对话（.txt 纯文本）</p>
        </div>
        <div class="restart-options">
          <button class="btn restart-btn" data-choice="full" style="color: var(--color-amber-500, #D4A017); border-color: var(--color-amber-500, #D4A017);">完整内容</button>
          <p class="restart-hint">包含所有字段（动作、情绪、状态等，.json）</p>
        </div>
        <div class="restart-actions">
          <button class="btn restart-cancel-btn">取消</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    overlay.querySelector('[data-choice="summary"]').addEventListener('click', () => {
      overlay.remove();
      resolve('summary');
    });
    overlay.querySelector('[data-choice="full"]').addEventListener('click', () => {
      overlay.remove();
      resolve('full');
    });
    overlay.querySelector('.restart-cancel-btn').addEventListener('click', () => {
      overlay.remove();
      resolve(null);
    });
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        overlay.remove();
        resolve(null);
      }
    });
  });
}

// ============ 工具函数 ============

function escapeHtml(str) {
  if (str == null) return '';
  // 注意：要在 attribute 场景下也安全，必须转义 " 和 '
  // （HTML 解析在双引号包裹的属性中遇到 " 就会提前结束，导致 data-action 等被截断）
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function parseTags(tags) {
  if (!tags) return [];
  if (Array.isArray(tags)) return tags;
  try {
    const parsed = JSON.parse(tags);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return tags.split(',').map(t => t.trim()).filter(Boolean);
  }
}

function formatTime(dateStr) {
  if (!dateStr) return '';
  try {
    const d = new Date(dateStr + (dateStr.includes('Z') || dateStr.includes('+') ? '' : 'Z'));
    return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

function toHex(color) {
  if (!color) return '#000000';
  if (color.startsWith('#') && color.length >= 7) return color.slice(0, 7);
  try {
    const ctx = document.createElement('canvas').getContext('2d');
    // Normalize rgba(r, g, b, a) and rgb(r g b / a) → rgb(r,g,b)
    const normalized = color.replace(/rgba?\(([^)]+)\)/g, (m, inner) => {
      const parts = inner.replace(/\//g, ',').split(',').slice(0, 3).join(',');
      return m.startsWith('rgba') ? 'rgb(' + parts + ')' : 'rgb(' + parts + ')';
    });
    ctx.fillStyle = normalized;
    return ctx.fillStyle;
  } catch {
    return '#000000';
  }
}

function debounce(fn, delay) {
  let timer;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
}

// ============ TTS Module (Async Buffer + Player Bar) ============
//
// Architecture:
//   - TTSBuffer: background worker that receives segments, requests TTS one-by-one,
//     waits for audio response before sending next segment.
//   - TTSPlayer: manages playback queue, play/pause/prev/next/stop,
//     drives the player bar UI.
//   - Text rendering and TTS are fully decoupled.
//

// --- Legacy compat globals ---
let _ttsCurrentAudio = null;
let _ttsStopRequested = false;
window._ttsPlaying = false;

// ===================== TTSBuffer =====================
// Receives segments, builds tasks, fetches audio one at a time.
// Emits events: 'audioReady', 'taskError', 'allDone', 'progress'

class TTSBuffer extends EventTarget {
  constructor() {
    super();
    this.tasks = [];        // [{text, voice, audioBlob, audioUrl, duration, status, error}]
    this.currentIndex = -1; // next task to fetch
    this.roster = {};
    this.voiceMap = {};
    this.cacheGame = '';
    this.cacheTurn = '';
    this._fetching = false;
    this._stopped = false;
  }

  /** Submit new segments (from AI response). Clears previous buffer. */
  async submit(segments, context) {
    this.clear();
    this._stopped = false;

    // Load voice map
    try {
      const resp = await fetch('/api/tts/providers');
      const providers = await resp.json();
      const def = providers.find(p => p.is_default === 1) || providers[0];
      if (def) {
        this.voiceMap = typeof def.voice_map === 'string'
          ? JSON.parse(def.voice_map || '{}') : (def.voice_map || {});
        this.format = def.api_format || 'openai';
      }
    } catch { }
    // 确保 TTS 所需的【详细名册】已就绪。声线解析依赖 AppState.characterRoster 为
    // 「按角色全名 key 的对象(含 种族性别/年龄)」。若 loadConversation 时没匹配到存档、
    // 名册为空 {}，则所有对白会回落旁白声线、角色失去各自音色。这里主动兜底拉取。
    await ttsEnsureRoster();
    this.roster = AppState.characterRoster || {};

    // Build tasks (format 用于区分 ComfyUI VoiceDesign 模式：voice=类型标签, emotion=仅 AI 情绪)
    const tasks = ttsBuildTasks(segments, this.roster, this.voiceMap, this.format);
    if (tasks.length === 0) return;

    // Cache context
    this.cacheGame = (context?.gameName || AppState.currentCharacter?.name || 'game').replace(/[\\/:*?"<>|]/g, '_');
    this.cacheTurn = context?.turn || Date.now();
    if (context?.msgDiv) {
      context.msgDiv.dataset.ttsCacheGame = this.cacheGame;
      context.msgDiv.dataset.ttsCacheTurn = this.cacheTurn;
    }

    this.tasks = tasks.map((t, i) => ({
      text: t.text, voice: t.voice, emotion: t.emotion, narrator: !!t.narrator,
      audioBlob: null, audioUrl: null, duration: 0,
      status: 'pending', // pending | fetching | ready | error
      error: null, segIdx: i
    }));

    this.dispatchEvent(new CustomEvent('progress', { detail: { total: this.tasks.length, ready: 0, fetching: 0 } }));

    // Start background fetch
    this._fetchNext();
  }

  /** Fetch next pending task (one at a time), with retry on transient failure */
  async _fetchNext() {
    if (this._fetching || this._stopped) return;
    // Find next pending task
    const idx = this.tasks.findIndex(t => t.status === 'pending');
    if (idx === -1) {
      // All done or all errored
      const readyCount = this.tasks.filter(t => t.status === 'ready').length;
      if (readyCount > 0 || this.tasks.some(t => t.status === 'error')) {
        this.dispatchEvent(new CustomEvent('allDone'));
      }
      return;
    }

    this._fetching = true;
    const task = this.tasks[idx];
    task.status = 'fetching';
    task.attempts = task.attempts || 0;
    this.dispatchEvent(new CustomEvent('progress', { detail: this._getProgress() }));

    const maxRetries = 3; // total attempts = 1 + 3 retries
    let lastErr = null;
    while (task.attempts <= maxRetries) {
      if (this._stopped) { this._fetching = false; return; }
      try {
        const body = {
          text: task.text,
          cache_game: this.cacheGame,
          cache_turn: this.cacheTurn,
          cache_seg: idx
        };
        if (task.voice) body.voice = task.voice;
        if (task.emotion) body.instruction = task.emotion;
        if (task.narrator) body.narrator = true; // 旁白标记：后端据此锁定旁白声线，避免回落女声默认

        // TTS generation (esp. local large models) can take minutes. Use a uniform,
        // generous timeout so retries aren't cut shorter than the first attempt,
        // and it stays >= the backend's own call timeout (600s).
        const timeoutMs = 600000; // 10 minutes
        const ctrl = new AbortController();
        const fetchTimer = setTimeout(() => ctrl.abort(), timeoutMs);
        const resp = await fetch('/api/tts/speak', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: ctrl.signal
        });
        clearTimeout(fetchTimer);

        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

        // Play from the on-disk cache file via HTTP — do NOT consume the raw audio stream
        // into a blob. The complete cached file is authoritative; reading the live stream
        // was the source of mid-sentence cutoffs. The backend returns the cache filename
        // in the X-TTS-Cache-File header.
        const cacheFile = resp.headers.get('X-TTS-Cache-File');
        const queued = resp.headers.get('X-TTS-Queued') === '1';
        if (queued) {
          // 后端已将本段入队（一次性请求过多时），稍后由播放器 _waitForCacheFile
          // 轮询等待生成完成。弹悬浮提示，待服务端积压清空后自动消失。
          const pend = parseInt(resp.headers.get('X-TTS-Pending') || '0', 10);
          showTtsQueueBanner(pend);
        }
        if (!cacheFile) {
          // Fallback (shouldn't happen): old behaviour, blob from the stream.
          const blob = await resp.blob();
          if (blob.size < 100) throw new Error('Audio too small');
          task.audioBlob = blob;
          task.audioUrl = URL.createObjectURL(blob);
        } else {
          task.cacheFile = cacheFile;
          task.audioUrl = '/api/tts/cache-file/' + encodeURIComponent(cacheFile);
          task.audioBlob = null;
        }
        task.status = 'ready';
        const cacheHit = resp.headers.get('X-TTS-Cache');
        console.log(`[TTSBuffer] ${idx + 1}/${this.tasks.length} voice=${task.voice || 'default'} cache=${cacheHit} file=${cacheFile || '(blob)'} (${task.text.length} chars)`);

        this.dispatchEvent(new CustomEvent('audioReady', { detail: { index: idx, task } }));
        this._fetching = false;
        this.dispatchEvent(new CustomEvent('progress', { detail: this._getProgress() }));
        if (!this._stopped) this._fetchNext();
        return;
      } catch (e) {
        lastErr = e;
        task.attempts++;
        if (task.attempts <= maxRetries) {
          // Exponential backoff capped at 8s; bail immediately if stopped
          const backoff = Math.min(1000 * Math.pow(2, task.attempts - 1), 8000);
          console.warn(`[TTSBuffer] Task ${idx} attempt ${task.attempts} failed: ${e.message}; retrying in ${backoff}ms`);
          if (this._stopped) { this._fetching = false; return; }
          await new Promise(r => setTimeout(r, backoff));
        }
      }
    }
    // All retries exhausted → mark as error (player will skip it, not hang)
    task.status = 'error';
    task.error = lastErr ? lastErr.message : 'unknown';
    console.error(`[TTSBuffer] Task ${idx} FAILED after ${task.attempts} attempts:`, task.error);
    this.dispatchEvent(new CustomEvent('taskError', { detail: { index: idx, task, error: task.error } }));
    this._fetching = false;
    this.dispatchEvent(new CustomEvent('progress', { detail: this._getProgress() }));
    if (!this._stopped) this._fetchNext();
  }

  _getProgress() {
    return {
      total: this.tasks.length,
      ready: this.tasks.filter(t => t.status === 'ready').length,
      fetching: this.tasks.filter(t => t.status === 'fetching').length,
      pending: this.tasks.filter(t => t.status === 'pending').length,
      error: this.tasks.filter(t => t.status === 'error').length
    };
  }

  /** Stop all fetching */
  stop() {
    this._stopped = true;
  }

  /** Clear buffer */
  clear() {
    this._stopped = true;
    this._fetching = false;
    // Revoke any leftover blob URLs (cache-file HTTP URLs need no revoking)
    for (const t of this.tasks) {
      if (t.audioUrl && t.audioUrl.startsWith('blob:')) { try { URL.revokeObjectURL(t.audioUrl); } catch { } }
    }
    this.tasks = [];
    this.currentIndex = -1;
  }
}

// ===================== TTSPlayer =====================
// Plays audio from TTSBuffer in order. Supports prev/next/play/pause/stop.

class TTSPlayer extends EventTarget {
  constructor(buffer) {
    super();
    this.buffer = buffer;
    this.playIndex = 0;    // current playing index
    this.audio = null;     // current Audio object
    this.playing = false;
    this._erroredOnce = false;   // retry guard for per-segment audio errors
    this._endedReplayed = false; // retry guard for premature 'ended'
    this.paused = false;
    this._endedHandler = null;
    this._active = false;     // playback session active (playing or waiting)
    this._waitingFor = null;  // index we are waiting to become ready before auto-advancing
    this._needsGesture = false; // true when autoplay was blocked and we need a user click
    this._queue = [];        // FIFO of pending {segments, context} awaiting their turn
    this._userSwitch = false; // true only for user-initiated jumps (prev/jumpTo/▶) so the
                              // hard overlap guard below allows an intentional switch

    // Listen to buffer events
    buffer.addEventListener('audioReady', (e) => this._onAudioReady(e.detail));
    buffer.addEventListener('allDone', () => { this._onAllDone(); scheduleHideTtsQueueBanner(); });
    buffer.addEventListener('taskError', (e) => this._onTaskError(e.detail));
    buffer.addEventListener('progress', (e) => this._onProgress(e.detail));
  }

  /** Play from specific index */
  async playFrom(index) {
    if (index < 0 || index >= this.buffer.tasks.length) return;
    // HARD GUARD: automatic playback must NEVER cut off a segment that is still speaking.
    // Every automatic caller (next()/_onAudioReady) only ever requests the current
    // playIndex after the previous segment's `ended` event, so a genuine automatic call
    // with a different index while playing==true is a bug — block it (and log it so we
    // can see it). User-initiated jumps set this._userSwitch to intentionally switch.
    if (this.playing && this.playIndex !== index && !this._userSwitch) {
      console.warn(`[TTSPlayer] Blocked overlap: tried to auto-play #${index} while #${this.playIndex} still playing`);
      return;
    }
    // Also never re-play the segment that is already playing (avoids double-trigger glitch).
    if (this.playing && this.playIndex === index) return;
    this._userSwitch = false; // consume the one-shot user-switch flag
    const task = this.buffer.tasks[index];
    if (task.status !== 'ready') {
      console.warn(`[TTSPlayer] Task ${index} not ready (status=${task.status})`);
      return;
    }

    this._active = true;
    this._waitingFor = null;
    this._needsGesture = false;
    this._stopCurrent();
    this.playIndex = index;
    this._erroredOnce = false;     // per-segment error retry guard
    this._endedReplayed = false;   // per-segment premature-ended replay guard
    this.paused = false;
    _ttsStopRequested = false;

    // Pause BGM
    this._pauseBGM();

    // Wait for the complete cached file on disk before playing. The player NEVER reads a
    // half-written file via the live stream — it plays the finished file over HTTP, and if
    // generation hasn't flushed yet it polls 404->200 instead of cutting the previous
    // sentence off.
    const fileOk = await this._waitForCacheFile(task.audioUrl);
    if (this._stopped || _ttsStopRequested) { this._active = false; this._resumeBGM(); return; }
    if (!fileOk) {
      console.warn(`[TTSPlayer] Cache file missing for #${index} after waiting; advancing`);
      this._active = false; this._resumeBGM(); this.next(); return;
    }

    this.playing = true;
    window._ttsPlaying = true;
    this.audio = new Audio(task.audioUrl);
    _ttsCurrentAudio = this.audio;
    this.audio.volume = 1.0;
    this.audio.load(); // ensure the media is loaded before play()

    this._endedHandler = () => {
      const a = this.audio;
      const dur = a ? a.duration : 0;
      const cur = a ? a.currentTime : 0;
      // Browsers occasionally fire `ended` far earlier than the clip's declared
      // duration for blob audio (truncated/corrupt clip, or a decode quirk). Replay
      // once; only advance when it truly played to (near) the end.
      if (dur > 0 && cur > 0 && cur < dur - 0.3) {
        if (!this._endedReplayed) {
          this._endedReplayed = true;
          console.warn(`[TTSPlayer] Premature ended @${cur.toFixed(2)}/${dur.toFixed(2)}s, replaying #${index}`);
          try { a.currentTime = 0; a.play().catch(() => { }); } catch (e) { /* noop */ }
          return;
        }
        console.warn(`[TTSPlayer] Segment #${index} still truncated after replay; advancing`);
      }
      this._endedReplayed = false;
      this.playing = false;
      window._ttsPlaying = false;
      this._resumeBGM();
      this.dispatchEvent(new CustomEvent('segmentEnded', { detail: { index } }));
      // Auto-advance to next
      this.next();
    };
    this.audio.addEventListener('ended', this._endedHandler, { once: true });
    this.audio.addEventListener('error', (e) => {
      // Read the REAL error from the event target (this.audio?.error is often null
      // at handler time, which masked the true cause as code=undefined).
      const tgt = e.target || this.audio;
      const err = tgt.error;
      const code = err ? err.code : 'n/a(likely autoplay/gesture block, no MediaError)';
      const msg = err ? err.message : '';
      const src = (task.audioUrl || '').slice(-50);
      console.warn(`[TTSPlayer] Audio error on #${index}: code=${code} msg=${msg} src=${src}`);
      // Only retry on a genuine media/decode error (err present). A spurious first-play
      // error (e.g. WebView/autoplay quirk) usually recovers on reload+replay.
      if (!this._erroredOnce && err) {
        this._erroredOnce = true;
        this.playing = false;
        try { this.audio.load(); const p = this.audio.play(); if (p && p.catch) p.catch(() => { }); } catch (_) { /* noop */ }
        return;
      }
      // Autoplay/gesture block (err null) or a persistent failure: do NOT silently
      // stall the whole playlist. Surface it and advance so remaining segments play.
      this._erroredOnce = false;
      this.playing = false;
      window._ttsPlaying = false;
      this._resumeBGM();
      this.dispatchEvent(new CustomEvent('segmentError', { detail: { index } }));
      this.next();
    }); // NOTE: intentionally NOT { once:true } — retry must stay observable

    try {
      await this.audio.play();
      this._needsGesture = false;
      this.dispatchEvent(new CustomEvent('playing', { detail: { index, task } }));
    } catch (playErr) {
      if (playErr.name === 'AbortError') {
        this.playing = false;
        window._ttsPlaying = false;
        return;
      }
      if (playErr.name === 'NotAllowedError') {
        // Browser blocked programmatic autoplay (no user gesture). Wait for the user
        // to click ▶ — togglePlay() will retry playFrom() and succeed within the gesture.
        this.playing = false;
        window._ttsPlaying = false;
        this._needsGesture = true;
        showToast('浏览器阻止了自动播放，请点击 ▶ 继续', 'warning', 4000);
        this.dispatchEvent(new CustomEvent('waiting', { detail: { index, blocked: true } }));
        return;
      }
      throw playErr;
    }
  }

  /** Toggle play/pause */
  togglePlay() {
    if (this.playing && !this.paused) {
      this.pause();
    } else if (this.paused) {
      this.resume();
    } else {
      // Start from current index (user-initiated — allow switching)
      const task = this.buffer.tasks[this.playIndex];
      if (task && task.status === 'ready') {
        this._userSwitch = true;
        this.playFrom(this.playIndex);
      } else {
        // Find first ready task
        const firstReady = this.buffer.tasks.findIndex(t => t.status === 'ready');
        if (firstReady >= 0) { this._userSwitch = true; this.playFrom(firstReady); }
      }
    }
  }

  pause() {
    if (this.audio && this.playing) {
      this.audio.pause();
      this.paused = true;
      this.dispatchEvent(new CustomEvent('paused'));
    }
  }

  resume() {
    if (this.audio && this.paused) {
      this.audio.play().catch(() => { });
      this.paused = false;
      this.playing = true;
      this.dispatchEvent(new CustomEvent('resumed'));
    }
  }

  /** Find next playable task index >= start.
   *  'ready'/'pending'/'fetching' are playable (pending/fetching worth waiting for);
   *  'error' tasks are skipped so a failed segment never blocks the rest. */
  _nextPlayable(start) {
    for (let i = start; i < this.buffer.tasks.length; i++) {
      const s = this.buffer.tasks[i].status;
      if (s === 'ready' || s === 'pending' || s === 'fetching') return i;
    }
    return -1;
  }

  /** Go to next segment.
   *  - ready     -> play immediately
   *  - pending/  -> WAIT for it to finish generating (never skip a not-yet-ready segment)
   *    fetching
   *  - error     -> skip past it (user is notified via toast in _onTaskError)
   *  If there is nothing playable yet but the buffer still has in-flight tasks, we
   *  wait for `allDone` rather than finishing early. */
  next() {
    const idx = this._nextPlayable(this.playIndex + 1);
    if (idx === -1) {
      this._waitingFor = null;
      // Still generating somewhere? Let allDone re-evaluate so we never finish early.
      const anyPending = this.buffer.tasks.some(t => t.status === 'pending' || t.status === 'fetching');
      if (anyPending) return;
      this._finish();
      return;
    }
    this.playIndex = idx;
    const task = this.buffer.tasks[idx];
    if (task.status === 'ready') {
      this._waitingFor = null;
      this.playFrom(idx);
    } else {
      // pending / fetching — hold here until audioReady (or taskError) fires for this index.
      // Advance playIndex NOW so that when this segment becomes ready, the _onAudioReady
      // guard `detail.index === this.playIndex` matches and it auto-plays (no stall after
      // the first segment). This is the fix for "only the first segment plays".
      this.playIndex = idx;
      this._waitingFor = idx;
      this.dispatchEvent(new CustomEvent('waiting', { detail: { index: idx } }));
    }
  }

  /** Go to previous segment */
  prev() {
    const prevIdx = Math.max(0, this.playIndex - 1);
    if (prevIdx !== this.playIndex) {
      this._userSwitch = true;
      this.playFrom(prevIdx);
    } else if (prevIdx === 0) {
      this._userSwitch = true;
      this.playFrom(0);
    }
  }

  /** Stop everything */
  stop() {
    hideTtsQueueBanner();
    this._stopCurrent();
    this.playing = false;
    this.paused = false;
    this._active = false;
    this._waitingFor = null;
    window._ttsPlaying = false;
    _ttsStopRequested = true;
    this.buffer.stop();
    this._queue = [];          // user-initiated stop cancels any queued replies
    this._resumeBGM();
    this.dispatchEvent(new CustomEvent('stopped'));
  }

  /** Jump to a specific segment by index (used by playlist/list clicks).
   *  - ready      -> switch playback to it immediately (stops current, plays clicked)
   *  - pending/   -> switch target: stop current and wait for the clicked segment
   *    fetching     to finish generating, then play it (works mid-autoplay)
   *  - error      -> toast, do nothing */
  jumpTo(index) {
    const task = this.buffer.tasks[index];
    if (!task) return;
    this._active = true;
    if (task.status === 'ready') {
      this._waitingFor = null;
      this._userSwitch = true;
      this.playFrom(index);
    } else if (task.status === 'pending' || task.status === 'fetching') {
      this._stopCurrent();
      this.playIndex = index;
      this.playing = false;
      this.paused = false;
      this._waitingFor = index;
      this.dispatchEvent(new CustomEvent('waiting', { detail: { index } }));
    } else if (task.status === 'error') {
      showToast(`第 ${index + 1} 段生成失败，无法播放`, 'error', 3000);
    }
  }

  _stopCurrent() {
    if (this.audio) {
      try {
        if (this._endedHandler) this.audio.removeEventListener('ended', this._endedHandler);
        this.audio.pause();
        this.audio.src = '';
      } catch { }
      this.audio = null;
      _ttsCurrentAudio = null;
    }
  }

  /** Poll a cached-file URL until it returns 200 (file flushed to disk) or timeout.
   *  Lets the player wait for a still-generating segment instead of reading a partial
   *  file or interrupting the previous one. */
  async _waitForCacheFile(url, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(url, { method: 'HEAD' });
        if (r.ok) return true;
      } catch (e) { /* transient network error, retry */ }
      if (this._stopped || _ttsStopRequested) return false;
      await new Promise(r => setTimeout(r, 300));
    }
    return false;
  }

  // ---- Cross-message playback queue ----
  // A new AI reply's TTS is queued behind whatever is currently being read, so the
  // next reply never interrupts the sentence in progress. The queue auto-advances.
  enqueueOrPlay(segments, context) {
    // Gate on a live session, a playing audio, OR any in-flight buffer task. A new AI
    // reply must never interrupt the sentence currently being read — even if _active
    // desynced, as long as audio is playing (or still being fetched) we queue it. The
    // player auto-advances through the queue.
    const bufferBusy = this._active || this.playing ||
      ttsBuffer.tasks.some(t => t.status === 'pending' || t.status === 'fetching');
    if (bufferBusy) {
      this._queue.push({ segments, context });
      return;
    }
    this._startSegments(segments, context);
  }

  _startSegments(segments, context) {
    // Safety net: if audio is still playing (e.g. a queued round was dequeued a hair
    // early), defer instead of submitting — submit() clears the shared buffer and would
    // otherwise cut off / steal the in-progress playback.
    if (this.playing) {
      this._queue.push({ segments, context });
      return;
    }
    this._active = true;
    this._waitingFor = null;
    this.playIndex = 0;
    ttsUpdatePlaylist();
    ttsUpdatePlayerUI();
    // submit() returns once tasks are built + background fetch is kicked off; the FIRST
    // segment of this round auto-plays via _onAudioReady. (We don't await here so the
    // call site stays non-blocking.) All subsequent segments are picked up strictly
    // sequentially by next()/_onAudioReady AFTER the previous one finishes — they never
    // auto-play out of turn, which is what keeps a round from interrupting itself.
    ttsBuffer.submit(segments, context).then(() => {
      if (ttsBuffer.tasks.length === 0) {
        // Nothing to play (e.g. all segments filtered out) — end this session and
        // advance the queue.
        this._active = false;
        this._playPending();
        return;
      }
      if (ttsBuffer.tasks[0]?.status === 'ready') this.playFrom(0);
    });
  }

  _playPending() {
    const next = this._queue.shift();
    if (next) this._startSegments(next.segments, next.context);
  }

  _finish() {
    this._stopCurrent();
    this.playing = false;
    this.paused = false;
    this._active = false;
    this._waitingFor = null;
    window._ttsPlaying = false;
    this._resumeBGM();
    this.dispatchEvent(new CustomEvent('finished'));
    this._playPending();
  }

  _pauseBGM() {
    if (typeof BGM_STATE !== 'undefined' && BGM_STATE.isPlaying && BGM_STATE.audioEl) {
      BGM_STATE.audioEl.pause();
      BGM_STATE.isPlaying = false;
      this._bgmWasPlaying = true;
    }
  }

  _resumeBGM() {
    if (this._bgmWasPlaying && typeof BGM_STATE !== 'undefined' && BGM_STATE.enabled && BGM_STATE.audioEl) {
      setTimeout(() => BGM_STATE.audioEl.play().then(() => BGM_STATE.isPlaying = true).catch(() => { }), 300);
      this._bgmWasPlaying = false;
    }
  }

  // Buffer event handlers

  _onAudioReady(detail) {
    // Auto-play ONLY when this is the segment we are currently positioned on and we are
    // not already playing/paused. This guarantees we never jump ahead of a segment that
    // is still generating — we wait for its audioReady event in order.
    if (!this.playing && !this.paused && detail.index === this.playIndex) {
      const task = this.buffer.tasks[detail.index];
      if (task && task.status === 'ready') {
        this._waitingFor = null;
        this.playFrom(detail.index);
      }
      // If not ready (shouldn't happen), keep waiting — do not skip.
    }
    this.dispatchEvent(new CustomEvent('bufferUpdate'));
  }

  _onTaskError(detail) {
    // Surface generation failures to the user via a toast (only during an active session).
    if (this._active) {
      showToast(`语音生成失败（第 ${detail.index + 1} 段）：${detail.error || '未知错误'}`, 'error', 5000);
    }
    // If we were waiting on this exact segment (not playing, index matches), skip past it
    // and continue with the rest. Otherwise it will be skipped naturally when reached.
    if (!this.playing && !this.paused && detail.index === this.playIndex) {
      this._waitingFor = null;
      this.dispatchEvent(new CustomEvent('segmentSkipped', { detail: { index: detail.index, reason: detail.error } }));
      this.next();
    }
    this.dispatchEvent(new CustomEvent('bufferUpdate'));
  }

  _onAllDone() {
    // If we were waiting for a segment that never became ready (e.g. it errored without
    // notifying), re-evaluate. next() will finish if nothing playable remains.
    if (this._active && this._waitingFor !== null && !this.playing && !this.paused) {
      this._waitingFor = null;
      this.next();
    }
    this.dispatchEvent(new CustomEvent('bufferUpdate'));
  }

  _onProgress(detail) {
    this.dispatchEvent(new CustomEvent('bufferProgress', { detail }));
  }
}

// ===================== Global instances =====================
const ttsBuffer = new TTSBuffer();
const ttsPlayer = new TTSPlayer(ttsBuffer);

// Unlock programmatic audio playback on the first user interaction. TTS playback is
// started from fetch/ended callbacks (outside any click gesture), so without this the
// browser's autoplay policy would block the very first segment and nothing would play.
// A short silent WAV played once within a real gesture unlocks the audio context.
let _ttsAudioUnlocked = false;
function unlockAudio() {
  if (_ttsAudioUnlocked) return;
  _ttsAudioUnlocked = true;
  try {
    const a = new Audio('data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQQAAAD//w==');
    a.volume = 0;
    a.play().catch(() => { });
  } catch (e) { /* ignore */ }
}
['pointerdown', 'keydown', 'touchstart'].forEach(ev =>
  document.addEventListener(ev, unlockAudio, { once: true, capture: true }));

// ===================== Player Bar UI =====================

function ttsInitPlayerBar() {
  // The on-screen player bar was removed (2026-07-09); playback is now controlled via the
  // 🎧 floating list popup. Keep the popup toggle wired and refresh the popup list on every
  // playback-state change.
  document.getElementById('btnTTSListFloat')?.addEventListener('click', () => ttsToggleListPopup());
  document.getElementById('ttsListPopupClose')?.addEventListener('click', () => ttsCloseListPopup());
  document.getElementById('ttsListPopupStop')?.addEventListener('click', () => {
    ttsPlayer.stop();
    ttsRenderListPopup();
  });

  // Refresh the popup list on every playback-state change (no player-bar UI to update).
  ttsPlayer.addEventListener('playing', () => ttsRenderListPopup());
  ttsPlayer.addEventListener('paused', () => ttsRenderListPopup());
  ttsPlayer.addEventListener('resumed', () => ttsRenderListPopup());
  ttsPlayer.addEventListener('stopped', () => ttsRenderListPopup());
  ttsPlayer.addEventListener('finished', () => ttsRenderListPopup());
  ttsPlayer.addEventListener('waiting', () => ttsRenderListPopup());
  ttsPlayer.addEventListener('segmentEnded', () => ttsRenderListPopup());
  ttsPlayer.addEventListener('bufferUpdate', () => ttsRenderListPopup());
}

// ===================== TTS 排队悬浮提示 =====================
// 一次性发送的语音请求过多时，后端会入队并稍后合成。此时弹出居中悬浮条
// 「语音发送排队中，请稍候……」，并轮询 /api/tts/queue/status，待服务端积压
// 清空（pending===0）后自动消失。

let _ttsQueueBannerEl = null;
let _ttsQueueBannerTimer = null;
let _ttsQueueBannerHideTimer = null;

function _ensureTtsQueueBanner() {
  if (_ttsQueueBannerEl && document.body.contains(_ttsQueueBannerEl)) return _ttsQueueBannerEl;
  const el = document.createElement('div');
  el.id = 'ttsQueueBanner';
  el.textContent = '语音发送排队中，请稍候……';
  el.style.cssText = [
    'position:fixed', 'top:18px', 'left:50%', 'transform:translateX(-50%)',
    'z-index:99999', 'padding:10px 20px', 'border-radius:999px',
    'background:rgba(20,22,30,0.82)', 'color:#fff', 'font-size:14px', 'line-height:1',
    'box-shadow:0 6px 24px rgba(0,0,0,0.35)', 'backdrop-filter:blur(6px)',
    'display:flex', 'align-items:center', 'gap:10px', 'pointer-events:none',
    'font-family:system-ui,-apple-system,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif',
    'white-space:nowrap'
  ].join(';');
  const dot = document.createElement('span');
  dot.style.cssText = 'width:14px;height:14px;border-radius:50%;border:2px solid rgba(255,255,255,0.35);border-top-color:#fff;display:inline-block;animation:ttsQSpin 0.8s linear infinite';
  if (!document.getElementById('ttsQSpinStyle')) {
    const st = document.createElement('style');
    st.id = 'ttsQSpinStyle';
    st.textContent = '@keyframes ttsQSpin{to{transform:rotate(360deg)}}';
    document.head.appendChild(st);
  }
  el.prepend(dot);
  document.body.appendChild(el);
  _ttsQueueBannerEl = el;
  return el;
}

function showTtsQueueBanner(pending) {
  const el = _ensureTtsQueueBanner();
  el.style.display = 'flex';
  if (typeof pending === 'number' && pending > 0) {
    el.querySelector('span') && (el.childNodes[el.childNodes.length - 1].textContent =
      `语音发送排队中，请稍候……（队列 ${pending}）`);
  }
  // 启动轮询：积压清空即隐藏
  if (_ttsQueueBannerTimer) return;
  const poll = async () => {
    try {
      const r = await fetch('/api/tts/queue/status', { cache: 'no-store' });
      if (r.ok) {
        const s = await r.json();
        if (s && s.pending === 0) { hideTtsQueueBanner(); return; }
      }
    } catch { /* ignore */ }
    _ttsQueueBannerTimer = setTimeout(poll, 1500);
  };
  _ttsQueueBannerTimer = setTimeout(poll, 1500);
}

function hideTtsQueueBanner() {
  if (_ttsQueueBannerTimer) { clearTimeout(_ttsQueueBannerTimer); _ttsQueueBannerTimer = null; }
  if (_ttsQueueBannerHideTimer) { clearTimeout(_ttsQueueBannerHideTimer); _ttsQueueBannerHideTimer = null; }
  if (_ttsQueueBannerEl) _ttsQueueBannerEl.style.display = 'none';
}

// 全部任务已入队（buffer allDone）后给一点宽限再隐藏，避免生成仍在进行时提示过早消失
function scheduleHideTtsQueueBanner(graceMs) {
  if (_ttsQueueBannerHideTimer) clearTimeout(_ttsQueueBannerHideTimer);
  _ttsQueueBannerHideTimer = setTimeout(() => {
    // 若轮询已因 pending===0 隐藏，则无需动作
    fetch('/api/tts/queue/status', { cache: 'no-store' })
      .then(r => r.ok ? r.json() : null)
      .then(s => { if (!s || s.pending === 0) hideTtsQueueBanner(); })
      .catch(() => hideTtsQueueBanner());
  }, graceMs || 3000);
}

function ttsShowPlayerBar() {
  const bar = document.getElementById('ttsPlayerBar');
  if (bar) bar.classList.add('active');
}

function ttsHidePlayerBar() {
  const bar = document.getElementById('ttsPlayerBar');
  if (bar) bar.classList.remove('active');
  const drawer = document.getElementById('ttsPlaylistDrawer');
  if (drawer) drawer.classList.remove('open');
  const expandBtn = document.getElementById('ttsPlayerExpandBtn');
  if (expandBtn) expandBtn.classList.remove('expanded');
}

function ttsUpdatePlayerUI() {
  const btnPrev = document.getElementById('ttsBtnPrev');
  const btnNext = document.getElementById('ttsBtnNext');
  const trackFill = document.getElementById('ttsPlayerTrackFill');
  const segName = document.getElementById('ttsSegName');
  const segCount = document.getElementById('ttsSegCount');

  const tasks = ttsBuffer.tasks;
  const idx = ttsPlayer.playIndex;
  const total = tasks.length;

  // Prev/Next disable
  if (btnPrev) btnPrev.disabled = idx <= 0;
  if (btnNext) btnNext.disabled = idx >= total - 1;

  // Progress track
  if (trackFill) {
    const pct = total > 0 ? ((idx + 1) / total) * 100 : 0;
    trackFill.style.width = pct + '%';
  }

  // Segment info
  if (segName) {
    if (ttsPlayer._waitingFor !== null && !ttsPlayer.playing && !ttsPlayer.paused && tasks[ttsPlayer._waitingFor]) {
      segName.textContent = '⏳ 等待第 ' + (ttsPlayer._waitingFor + 1) + ' 段生成…';
    } else if (tasks[idx]) {
      const t = tasks[idx];
      const preview = t.text.length > 40 ? t.text.substring(0, 40) + '...' : t.text;
      segName.textContent = preview;
    } else {
      segName.textContent = '--';
    }
  }

  if (segCount) {
    const readyCount = tasks.filter(t => t.status === 'ready').length;
    segCount.textContent = `${readyCount}/${total}`;
  }
}

function ttsPlaylistItemHTML(t, i, currentIdx) {
  const isActive = i === currentIdx;
  const isLoading = t.status === 'fetching' || t.status === 'pending';
  const isReady = t.status === 'ready';
  const isError = t.status === 'error';
  const preview = t.text.length > 50 ? t.text.substring(0, 50) + '...' : t.text;
  const icon = isReady ? '&#9835;' : isError ? '&#10007;' : isLoading ? '&#8987;' : '&#9679;';
  const cls = isActive ? 'active' : isLoading ? 'loading' : '';
  const dur = t.duration > 0 ? `${Math.round(t.duration)}s` : '';
  return `<div class="tts-pl-item ${cls}" data-idx="${i}" onclick="ttsPlaylistJump(${i})">
    <span class="tts-pl-icon">${icon}</span>
    <span class="tts-pl-text">${preview}</span>
    <span class="tts-pl-dur">${dur}</span>
  </div>`;
}

function ttsUpdatePlaylist() {
  const drawer = document.getElementById('ttsPlaylistDrawer');
  if (!drawer) return;

  const tasks = ttsBuffer.tasks;
  const currentIdx = ttsPlayer.playIndex;

  drawer.innerHTML = tasks.map((t, i) => ttsPlaylistItemHTML(t, i, currentIdx)).join('');
}

/** Render the floating "pending playback" list popup (only when visible). */
function ttsRenderListPopup() {
  const popup = document.getElementById('ttsListPopup');
  const body = document.getElementById('ttsListPopupBody');
  if (!popup || !body) return;
  if (popup.classList.contains('hidden')) return; // skip work when closed

  const tasks = ttsBuffer.tasks;
  const currentIdx = ttsPlayer.playIndex;

  if (!tasks || tasks.length === 0) {
    body.innerHTML = '<div class="tts-pl-empty">\u6682\u65e0\u5f85\u64ad\u653e\u97f3\u9891<br>\uff08\u64ad\u653e\u8bed\u97f3\u540e\uff0c\u8fd9\u91cc\u4f1a\u663e\u793a\u672c\u5b58\u6863\u7684\u97f3\u9891\u5217\u8868\uff09</div>';
    return;
  }
  body.innerHTML = tasks.map((t, i) => ttsPlaylistItemHTML(t, i, currentIdx)).join('');
}

function ttsToggleListPopup() {
  const popup = document.getElementById('ttsListPopup');
  const btn = document.getElementById('btnTTSListFloat');
  if (!popup) return;
  if (popup.classList.contains('hidden')) {
    popup.classList.remove('hidden');
    btn?.classList.add('active');
    ttsRenderListPopup();
  } else {
    ttsCloseListPopup();
  }
}

function ttsCloseListPopup() {
  const popup = document.getElementById('ttsListPopup');
  const btn = document.getElementById('btnTTSListFloat');
  popup?.classList.add('hidden');
  btn?.classList.remove('active');
}

function ttsPlaylistJump(idx) {
  ttsPlayer.jumpTo(idx);
}

// ===================== TTS Modal (settings) =====================

function ttsStopPlayback() {
  ttsPlayer.stop();
  ttsHidePlayerBar();
}

function openTTS() {
  document.getElementById('ttsModal').classList.remove('hidden');
  initTtsMasterSwitch();
  ttsLoadProviders();
  ttsLoadSettings();
}

function closeTTS() {
  document.getElementById('ttsModal').classList.add('hidden');
}

// --- Provider CRUD ---

async function ttsLoadProviders() {
  try {
    const resp = await fetch('/api/tts/providers');
    const providers = await resp.json();
    const list = document.getElementById('ttsProviderList');
    if (providers.length === 0) {
      list.innerHTML = '<div style="font-size:12px;color:var(--text-muted);padding:8px">\u6682\u65e0\u4f9b\u5e94\u5546\uff0c\u70b9\u51fb\u4e0b\u65b9\u6dfb\u52a0</div>';
      return;
    }
    list.innerHTML = providers.map(p => `
      <div style="display:flex;align-items:center;gap:8px;padding:6px 8px;border:1px solid var(--border-color);border-radius:6px;margin-bottom:4px">
        <input type="radio" name="ttsDefaultProvider" value="${p.id}" ${p.is_default ? 'checked' : ''} onchange="ttsSetDefault('${p.id}')">
        <div style="flex:1">
          <div style="font-weight:600">${p.name} ${p.is_default ? '\u2605' : ''}</div>
          <div style="font-size:11px;color:var(--text-muted)">${p.model} / ${p.voice} \u00b7 ${p.base_url}</div>
        </div>
        <button class="btn btn-sm" onclick="ttsEditProvider('${p.id}')" style="font-size:11px;padding:2px 6px">\u7f16\u8f91</button>
        <button class="btn btn-sm" onclick="ttsDeleteProvider('${p.id}')" style="font-size:11px;padding:2px 6px">\u5220\u9664</button>
      </div>
    `).join('');
  } catch (e) { console.error('[TTS] Load providers:', e); }
}

function ttsShowForm(id) {
  document.getElementById('ttsProviderForm').style.display = 'block';
  document.getElementById('ttsProviderFormTitle').textContent = id ? '\u7f16\u8f91\u4f9b\u5e94\u5546' : '\u6dfb\u52a0\u4f9b\u5e94\u5546';
  document.getElementById('ttsProviderId').value = id || '';
  if (!id) {
    ['ttsProviderName', 'ttsProviderUrl', 'ttsProviderKey'].forEach(i => document.getElementById(i).value = '');
    document.getElementById('ttsApiFormat').value = 'openai';
    document.getElementById('ttsProviderModel').value = '';
    document.getElementById('ttsProviderModelCustom').value = '';
    document.getElementById('ttsProviderVoice').value = 'alloy';
    document.getElementById('ttsProviderSpeed').value = '1.0';
    document.getElementById('ttsProviderLanguage').value = 'zh-CN';
    document.getElementById('ttsProviderInstruction').value = '';
    document.getElementById('ttsProviderDefault').checked = false;
    const mc = document.getElementById('ttsModelCount');
    if (mc) mc.style.display = 'none';
    // Reset voice map dropdowns + instruct inputs
    ['narrator', 'female_teen', 'female_young', 'female_mature', 'male_teen', 'male_young', 'male_mature'].forEach(key => {
      const el = document.getElementById('ttsVm_' + key);
      if (el) { el.innerHTML = '<option value="">(默认)</option>'; el.value = ''; }
    });
    ttsToggleFormatFields();
  }
}

function ttsToggleFormatFields() {
  const fmt = document.getElementById('ttsApiFormat').value;
  document.getElementById('ttsLanguageGroup').style.display = (fmt === 'nvidia' || fmt === 'comfyui') ? 'block' : 'none';
  // ComfyUI (Qwen3-TTS VoiceDesign) 没有云端音色列表，标签是静态 12 类，直接填充下拉框
  if (fmt === 'comfyui') ttsPopulateComfyLabels();
  // Update key hint + URL placeholder based on format
  const keyHint = document.getElementById('ttsKeyHint');
  const urlInput = document.getElementById('ttsProviderUrl');
  const keyInput = document.getElementById('ttsProviderKey');
  if (fmt === 'volcengine') {
    if (keyHint) keyHint.textContent = '(Agent Plan API Key, 控制台获取)';
    if (urlInput) urlInput.placeholder = 'https://openspeech.bytedance.com/api/v3/plan/tts/unidirectional';
    if (keyInput) keyInput.placeholder = 'Agent Plan API Key';
  } else if (fmt === 'nvidia') {
    if (keyHint) keyHint.textContent = '';
    if (urlInput) urlInput.placeholder = 'https://integrate.api.nvidia.com/v1';
    if (keyInput) keyInput.placeholder = 'nvapi-...';
  } else if (fmt === 'comfyui') {
    if (keyHint) keyHint.textContent = '(本机 ComfyUI 无需 Key)';
    if (urlInput) urlInput.placeholder = 'http://127.0.0.1:8188';
    if (keyInput) keyInput.placeholder = '(留空)';
  } else if (fmt === 'bailian') {
    if (keyHint) keyHint.textContent = '(百炼 API Key)';
    if (urlInput) urlInput.placeholder = 'https://dashscope.aliyuncs.com/api/v1';
    if (keyInput) keyInput.placeholder = 'sk-...';
  } else {
    if (keyHint) keyHint.textContent = '';
    if (urlInput) urlInput.placeholder = 'https://api.stepfun.ai/v1';
    if (keyInput) keyInput.placeholder = 'sk-...';
  }
}

function ttsHideForm() {
  document.getElementById('ttsProviderForm').style.display = 'none';
}

async function ttsEditProvider(id) {
  try {
    const resp = await fetch('/api/tts/providers');
    const providers = await resp.json();
    const p = providers.find(x => x.id === id);
    if (!p) return;
    ttsShowForm(id);
    document.getElementById('ttsProviderName').value = p.name;
    document.getElementById('ttsProviderUrl').value = p.base_url;
    document.getElementById('ttsProviderKey').value = '';
    document.getElementById('ttsApiFormat').value = p.api_format || 'openai';
    ttsToggleFormatFields();
    // 拉取该供应商模型列表填充下拉框，并默认选中已保存模型
    await ttsLoadModelList(p.model);
    // Fetch voices（按已保存模型返回合法音色）
    await ttsFetchVoices(p.base_url, p.model);
    document.getElementById('ttsProviderVoice').value = p.voice;
    document.getElementById('ttsProviderSpeed').value = p.speed;
    document.getElementById('ttsProviderLanguage').value = p.language || 'zh-CN';
    document.getElementById('ttsProviderInstruction').value = p.instruction || '';
    document.getElementById('ttsProviderDefault').checked = p.is_default === 1;
    // Load voice map (parse JSON string if needed)
    const vm = typeof p.voice_map === 'string' ? JSON.parse(p.voice_map || '{}') : (p.voice_map || {});
    ['narrator', 'female_teen', 'female_young', 'female_mature', 'male_teen', 'male_young', 'male_mature'].forEach(key => {
      const el = document.getElementById('ttsVm_' + key);
      if (el) el.value = vm[key] || '';
    });
  } catch (e) { console.error('[TTS] Edit:', e); }
}

async function ttsDeleteProvider(id) {
  if (!confirm('\u786e\u8ba4\u5220\u9664\u6b64\u4f9b\u5e94\u5546\uff1f')) return;
  await fetch(`/api/tts/providers/${id}`, { method: 'DELETE' });
  ttsLoadProviders();
}

async function ttsSetDefault(id) {
  await fetch(`/api/tts/providers/${id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ is_default: true })
  });
  ttsLoadProviders();
}

/** 收集「供应商表单」当前填写的供应商配置，供测试接口直接测试（无需先保存/设为默认）。
 *  注意：表单里的 api_key 是用户刚输入的明文，后端会据 _rawKey 标记跳过解密。 */
function ttsCollectFormProvider() {
  const id = document.getElementById('ttsProviderId').value.trim();
  const model = (document.getElementById('ttsProviderModelCustom').value.trim()
    || document.getElementById('ttsProviderModel').value.trim()) || 'tts-1';
  const p = {
    id,
    name: document.getElementById('ttsProviderName').value.trim() || 'test',
    base_url: document.getElementById('ttsProviderUrl').value.trim(),
    model,
    voice: document.getElementById('ttsProviderVoice').value.trim() || 'alloy',
    instruction: document.getElementById('ttsProviderInstruction').value.trim(),
    api_format: document.getElementById('ttsApiFormat').value,
    language: document.getElementById('ttsProviderLanguage').value
  };
  const key = document.getElementById('ttsProviderKey').value.trim();
  if (key) p.api_key = key;
  return p;
}

async function ttsSaveProvider() {
  const id = document.getElementById('ttsProviderId').value;
  // Collect voice map from 7 dropdowns
  const voiceMap = {};
  ['narrator', 'female_teen', 'female_young', 'female_mature', 'male_teen', 'male_young', 'male_mature'].forEach(key => {
    const el = document.getElementById('ttsVm_' + key);
    if (el && el.value) voiceMap[key] = el.value;
  });
  const data = {
    name: document.getElementById('ttsProviderName').value.trim(),
    base_url: document.getElementById('ttsProviderUrl').value.trim(),
    model: (document.getElementById('ttsProviderModelCustom').value.trim()
            || document.getElementById('ttsProviderModel').value.trim()) || 'tts-1',
    voice: document.getElementById('ttsProviderVoice').value.trim() || 'alloy',
    speed: parseFloat(document.getElementById('ttsProviderSpeed').value) || 1.0,
    instruction: document.getElementById('ttsProviderInstruction').value.trim(),
    api_format: document.getElementById('ttsApiFormat').value,
    language: document.getElementById('ttsProviderLanguage').value,
    voice_map: voiceMap,
    is_default: document.getElementById('ttsProviderDefault').checked
  };
  const key = document.getElementById('ttsProviderKey').value.trim();
  if (key) data.api_key = key;
  if (!data.name || !data.base_url) { alert('\u540d\u79f0\u548c\u5730\u5740\u5fc5\u586b'); return; }

  const method = id ? 'PUT' : 'POST';
  const url = id ? `/api/tts/providers/${id}` : '/api/tts/providers';
  await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  ttsHideForm();
  ttsLoadProviders();
}

async function ttsAddPreset(type) {
  const presets = {
    stepfun: { name: '\u9636\u8dc3 StepAudio', base_url: 'https://api.stepfun.ai/v1', model: 'stepaudio-2.5-tts', voice: 'cixingnansheng', api_format: 'openai' },
    openai: { name: 'OpenAI TTS', base_url: 'https://api.openai.com/v1', model: 'tts-1', voice: 'alloy', api_format: 'openai' },
    siliconflow: { name: '\u786c\u57fa TTS', base_url: 'https://api.siliconflow.cn/v1', model: 'FishAudio/fish-speech-1.5', voice: 'default', api_format: 'openai' },
    nvidia: { name: 'NVIDIA Magpie TTS', base_url: 'https://integrate.api.nvidia.com/v1', model: 'magpie-tts-zeroshot', voice: 'Magpie-Multilingual.ZH-CN.Aria', api_format: 'nvidia', language: 'zh-CN' },
    volcengine: { name: '\u706b\u5c71\u8c46\u5305 TTS (Agent Plan)', base_url: 'https://openspeech.bytedance.com/api/v3/plan/tts/unidirectional', model: 'seed-tts-2.0', voice: 'zh_female_gaolengyujie_uranus_bigtts', api_format: 'volcengine' },
    volink: { name: 'Volink CosyVoice', base_url: 'https://api.volink.org/v1', model: 'cosyvoice2-0.5b', voice: '68f05ee2fa7d57c78f362dff', api_format: 'openai' },
    qwenapi: { name: "Qwen TTS 云平台", format: "qwenapi", base_url: "", model: "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice", voice: "serena", api_format: "qwenapi" },
    qwenapi_local: { name: "Qwen TTS 本机", base_url: "http://127.0.0.1:7860", model: "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice", voice: "serena", api_format: "qwenapi_local" },
    comfyui: { name: "Qwen3-TTS 本机工作流", base_url: "http://127.0.0.1:8188", model: "Qwen3-TTS-12Hz-1.7B-VoiceDesign", voice: "沉稳专业", api_format: "comfyui", language: "zh-CN" },
    bailian: { name: "阿里云百炼 TTS", base_url: "https://dashscope.aliyuncs.com/api/v1", model: "qwen3-tts-flash", voice: "Cherry", api_format: "bailian" }
  };
  const p = presets[type];
  if (!p) return;
  ttsShowForm();
  document.getElementById('ttsProviderName').value = p.name;
  document.getElementById('ttsProviderUrl').value = p.base_url;
  document.getElementById('ttsApiFormat').value = p.api_format || 'openai';
  if (p.language) document.getElementById('ttsProviderLanguage').value = p.language;
  ttsToggleFormatFields();
  // 自动拉取该供应商模型列表并填充下拉框，再默认选中预设模型
  await ttsLoadModelList(p.model);
  // Auto-fetch voices for this provider（按预设模型返回合法音色）
  await ttsFetchVoices(p.base_url, p.model);
  document.getElementById('ttsProviderVoice').value = p.voice;
}

/** Fetch available models from provider's /v1/models */
async function ttsFetchModels() {
  const btn = document.getElementById('btnFetchTTSModels');
  const sel = document.getElementById('ttsProviderModel');
  const currentVal = sel.value;
  const baseUrl = document.getElementById('ttsProviderUrl').value.trim();
  const apiKey = document.getElementById('ttsProviderKey').value.trim();

  if (!baseUrl) { alert('\u8bf7\u5148\u586b\u5199 API \u5730\u5740'); return; }
  if (btn) { btn.disabled = true; btn.textContent = '...'; }

  try {
    const resp = await fetch('/api/tts/models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base_url: baseUrl, api_key: apiKey })
    });
    const models = await resp.json();
    if (models.error) throw new Error(models.error);
    if (Array.isArray(models) && models.length > 0) {
      // Populate select dropdown
      sel.innerHTML = models.map(m => `<option value="${m}">${m}</option>`).join('');
      // Keep current value or pick first
      if (models.includes(currentVal)) sel.value = currentVal;
      const hint = document.getElementById('ttsModelCount');
      if (hint) { hint.textContent = `\u2714 \u5df2\u62c9\u53d6 ${models.length} \u4e2a\u6a21\u578b`; hint.style.display = 'inline'; }
      console.log(`[TTS] Fetched ${models.length} models:`, models);
    } else {
      alert('\u672a\u83b7\u53d6\u5230\u6a21\u578b\u5217\u8868\uff08\u53ef\u80fd\u4f9b\u5e94\u5546\u4e0d\u652f\u6301 /v1/models \u7aef\u70b9\uff09\uff0c\u8bf7\u624b\u52a8\u8f93\u5165');
    }
  } catch (e) {
    console.error('[TTS] Fetch models:', e);
    alert('\u62c9\u53d6\u5931\u8d25: ' + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '\u4eceAPI\u62c9\u53d6'; }
  }
}

/** 拉取供应商模型列表并填充下拉框；若 defaultModel 在列表中则默认选中，否则回退到自定义输入框。 */
async function ttsLoadModelList(defaultModel) {
  await ttsFetchModels();
  const sel = document.getElementById('ttsProviderModel');
  const custom = document.getElementById('ttsProviderModelCustom');
  if (!sel) return;
  const has = [...sel.options].some(o => o.value && o.value === defaultModel);
  if (defaultModel && has) {
    sel.value = defaultModel;
    if (custom) custom.value = '';
  } else if (defaultModel) {
    // 下拉里没有该模型（如 API 未列出），写入自定义框作为兜底
    sel.value = '';
    if (custom) custom.value = defaultModel;
  }
}

/** Fetch voice presets for current base_url */
async function ttsFetchVoices(baseUrl, model) {
  const fmt = document.getElementById('ttsApiFormat').value;
  // ComfyUI 模式没有云端音色列表：标签是静态 12 类，直接填充下拉框即可
  if (fmt === 'comfyui') { ttsPopulateComfyLabels(); return; }
  const url = baseUrl || document.getElementById('ttsProviderUrl').value;
  if (!url) return;
  // 从表单取当前所选模型（用于后端按模型返回合法音色，避免跨模型错配 411）
  const selModel = model
    || document.getElementById('ttsProviderModelCustom').value.trim()
    || document.getElementById('ttsProviderModel').value.trim();
  const sel = document.getElementById('ttsProviderVoice');
  const btn = document.getElementById('btnFetchTTSVoices');
  const currentVal = sel.value;
  if (btn) { btn.disabled = true; btn.textContent = '...'; }

  try {
    const qs = 'base_url=' + encodeURIComponent(url) + (selModel ? '&model=' + encodeURIComponent(selModel) : '');
    const resp = await fetch('/api/tts/voices?' + qs);
    const voices = await resp.json();
    if (Array.isArray(voices) && voices.length > 0) {
      const options = voices.map(v => `<option value="${v.id}">${v.name} (${v.id})</option>`).join('');
      // Fill main voice select
      sel.innerHTML = `<option value="">(默认)</option>` + options;
      if (voices.find(v => v.id === currentVal)) sel.value = currentVal;
      // Fill voice map selects (7 categories)
      ['narrator', 'female_teen', 'female_young', 'female_mature', 'male_teen', 'male_young', 'male_mature'].forEach(key => {
        const vmSel = document.getElementById('ttsVm_' + key);
        if (vmSel) {
          const savedVal = vmSel.value;
          vmSel.innerHTML = `<option value="">(默认)</option>` + options;
          if (savedVal) vmSel.value = savedVal;
        }
      });
    }
  } catch (e) {
    console.error('[TTS] Fetch voices:', e);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '\u5237\u65b0'; }
  }
}

// --- Settings ---

/** Apply persisted switch state (localStorage is the single source of truth). */
function applyTtsSwitchState() {
  const me = document.getElementById('ttsMasterEnabled');
  if (me) me.checked = localStorage.getItem('rp-tts-enabled') === '1';   // default OFF
  const ap = document.getElementById('ttsAutoPlay');
  if (ap) ap.checked = localStorage.getItem('rp-tts-autoplay') !== '0';  // default ON
  const nn = document.getElementById('ttsNarrateNarration');
  if (nn) nn.checked = localStorage.getItem('rp-tts-narrate') === '1';   // default OFF
  const hb = document.getElementById('ttsHeartbeat');
  if (hb) hb.checked = localStorage.getItem('rp-tts-heartbeat') !== '0'; // default ON
}

/** Push the three server-backed toggles to the backend (debounced). */
let _ttsPersistTimer = null;
function persistTtsSettingsToServer() {
  const settings = {
    auto_play: document.getElementById('ttsAutoPlay')?.checked,
    narrate_narration: document.getElementById('ttsNarrateNarration')?.checked,
    heartbeat_enabled: document.getElementById('ttsHeartbeat')?.checked
  };
  fetch('/api/tts/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings)
  }).catch(e => console.error('[TTS] persist settings:', e));
}

/**
 * Load TTS switch state. localStorage is authoritative, so we only apply it here —
 * we must NOT overwrite the checkboxes from the server on every open/reload, otherwise
 * the user's toggles revert to stale server defaults (the "switch window -> resets" bug).
 * The server is kept in sync via persistTtsSettingsToServer() on every change.
 */
function ttsLoadSettings() {
  applyTtsSwitchState();
}

async function ttsSaveSettings() {
  const settings = {
    auto_play: document.getElementById('ttsAutoPlay').checked,
    narrate_narration: document.getElementById('ttsNarrateNarration').checked,
    heartbeat_enabled: document.getElementById('ttsHeartbeat') ? document.getElementById('ttsHeartbeat').checked : true
  };
  try {
    await fetch('/api/tts/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settings) });
    const s = document.getElementById('ttsSaveStatus');
    s.style.display = 'inline';
    setTimeout(() => s.style.display = 'none', 2000);
  } catch (e) { console.error('[TTS] Save:', e); }
}

// --- Master switch ---

/** Persistent master switch for all TTS playback */
function ttsMasterEnabled() {
  const cb = document.getElementById('ttsMasterEnabled');
  if (cb) return cb.checked;
  return localStorage.getItem('rp-tts-enabled') === '1';
}

/** Initialize TTS switches: localStorage is authoritative, synced to server on change. */
function initTtsMasterSwitch() {
  // Master switch (client-only gate) — also stops playback when turned off
  const me = document.getElementById('ttsMasterEnabled');
  if (me && me.dataset.bound !== '1') {
    me.dataset.bound = '1';
    me.addEventListener('change', () => {
      localStorage.setItem('rp-tts-enabled', me.checked ? '1' : '0');
      if (!me.checked) {
        try { ttsStopPlayback && ttsStopPlayback(); } catch (e) { /* noop */ }
      }
    });
  }
  // autoPlay / narrate / heartbeat — persist to localStorage + debounced server sync
  const bind = (id, lsKey) => {
    const cb = document.getElementById(id);
    if (!cb || cb.dataset.bound === '1') return;
    cb.dataset.bound = '1';
    cb.addEventListener('change', () => {
      localStorage.setItem(lsKey, cb.checked ? '1' : '0');
      clearTimeout(_ttsPersistTimer);
      _ttsPersistTimer = setTimeout(persistTtsSettingsToServer, 300);
    });
  };
  bind('ttsAutoPlay', 'rp-tts-autoplay');
  bind('ttsNarrateNarration', 'rp-tts-narrate');
  bind('ttsHeartbeat', 'rp-tts-heartbeat');
  applyTtsSwitchState();
  // One-time sync: push the (localStorage-backed) state to the server so the backend
  // heartbeat check and any cross-device load see the user's real choice, not stale
  // server defaults left by the old buggy code.
  if (!window._ttsSettingsPushed) {
    window._ttsSettingsPushed = true;
    clearTimeout(_ttsPersistTimer);
    _ttsPersistTimer = setTimeout(persistTtsSettingsToServer, 400);
  }
}

// --- Test ---

async function ttsTest() {
  if (window._ttsTesting) return;
  if (!ttsMasterEnabled()) {
    showToast('语音朗读已被总开关关闭，请先在语音朗读顶部启用', 'warning', 2500);
    return;
  }
  window._ttsTesting = true;
  const btn = document.getElementById('btnTTSTest');
  const statusEl = document.getElementById('ttsStatus');
  if (btn) btn.disabled = true;
  statusEl.textContent = '\u751f\u6210\u4e2d...';

  const bgmWasPlaying = (typeof BGM_STATE !== 'undefined') && BGM_STATE.isPlaying;
  if (bgmWasPlaying && BGM_STATE.audioEl) { BGM_STATE.audioEl.pause(); BGM_STATE.isPlaying = false; }

  try {
    const provider = ttsCollectFormProvider();
    const resp = await fetch('/api/tts/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...provider, text: '你好，这是语音合成测试。今天天气真不错。' })
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${(await resp.text()).substring(0, 100)}`);
    const blob = await resp.blob();
    if (blob.size < 100) throw new Error('Audio too small');

    if (_ttsCurrentAudio) { try { _ttsCurrentAudio.pause(); _ttsCurrentAudio.src = ''; } catch { } }
    const url = URL.createObjectURL(blob);
    _ttsCurrentAudio = new Audio(url);
    _ttsCurrentAudio.volume = 1.0;
    window._ttsPlaying = true;
    _ttsStopRequested = false;
    const stopBtn3 = document.getElementById('btnTTSStop');
    if (stopBtn3) stopBtn3.style.display = 'inline-block';
    // Wait for audio to be ready before playing
    await new Promise((resolve, reject) => {
      const onCanPlay = () => {
        _ttsCurrentAudio.removeEventListener('canplaythrough', onCanPlay);
        _ttsCurrentAudio.removeEventListener('error', onError);
        resolve();
      };
      const onError = (e) => {
        _ttsCurrentAudio.removeEventListener('canplaythrough', onCanPlay);
        _ttsCurrentAudio.removeEventListener('error', onError);
        reject(new Error('Audio load failed: ' + (_ttsCurrentAudio.error?.message || 'unknown')));
      };
      _ttsCurrentAudio.addEventListener('canplaythrough', onCanPlay, { once: false });
      _ttsCurrentAudio.addEventListener('error', onError, { once: false });
      _ttsCurrentAudio.load(); // Force load
    });

    try {
      await _ttsCurrentAudio.play();
      statusEl.textContent = '\u25cf \u6717\u8bfb\u4e2d';
      statusEl.style.color = '#34C759';
    } catch (playErr) {
      if (playErr.name === 'AbortError') {
        statusEl.textContent = '';
        URL.revokeObjectURL(url);
        _ttsCurrentAudio = null;
        window._ttsPlaying = false;
        if (stopBtn3) stopBtn3.style.display = 'none';
        return;
      }
      throw playErr;
    }
    _ttsCurrentAudio.addEventListener('ended', () => {
      statusEl.textContent = '';
      URL.revokeObjectURL(url);
      _ttsCurrentAudio = null;
      window._ttsPlaying = false;
      if (stopBtn3) stopBtn3.style.display = 'none';
      if (bgmWasPlaying && BGM_STATE.enabled && BGM_STATE.audioEl) {
        setTimeout(() => BGM_STATE.audioEl.play().catch(() => { }), 300);
      }
    }, { once: true });
  } catch (e) {
    console.error('[TTS] Test error:', e);
    statusEl.textContent = '\u26a0 ' + e.message.substring(0, 50);
    statusEl.style.color = '#FF3B30';
    window._ttsPlaying = false;
    if (bgmWasPlaying && BGM_STATE.enabled && BGM_STATE.audioEl) BGM_STATE.audioEl.play().catch(() => { });
  } finally {
    window._ttsTesting = false;
    if (btn) btn.disabled = false;
  }
}

// --- Voice map test (with caching) ---

/** In-memory cache: key = providerId|voice → { blobUrl, audio } */
const _ttsVoiceCache = new Map();
let _ttsVoiceTestAudio = null;

/** Stop any voice-map preview currently playing */
function _ttsStopVoicePreview() {
  if (_ttsVoiceTestAudio) {
    try { _ttsVoiceTestAudio.pause(); _ttsVoiceTestAudio.onended = null; _ttsVoiceTestAudio = null; } catch (e) { /* noop */ }
  }
}

/** Test a specific voice from the character voice-map.
 *  First click: fetches audio from server and caches it.
 *  Subsequent clicks: plays cached audio directly.
 */
async function ttsTestVoice(key) {
  if (!key) return;
  const sel = document.getElementById('ttsVm_' + key);
  if (!sel) return;
  const voice = sel.value;
  if (!voice) {
    showToast('该角色类型未选择音色，请先选择', 'warning', 2000);
    return;
  }

  // 试听使用固定兜底语气（无 AI 剧情上下文），与正式合成的中性/旁白兜底保持一致
  const testInstruct = (key === 'narrator') ? TTS_NARRATOR_INSTRUCTION : TTS_DIALOG_NEUTRAL_INSTRUCTION;

  // Build cache key from current editing provider id (or 'default') + voice
  const providerIdEl = document.getElementById('ttsProviderId');
  const providerId = (providerIdEl && providerIdEl.value) || 'default';
  const cacheKey = providerId + '|' + voice;

  // If currently playing, stop and exit (toggle behavior)
  if (_ttsVoiceTestAudio && !_ttsVoiceTestAudio.paused) {
    _ttsStopVoicePreview();
    return;
  }

  // Stop main TTS test if running to avoid overlap
  _ttsStopVoicePreview();

  // Update button visual feedback
  const btn = document.querySelector(`.tts-vm-test[data-vm="${key}"]`);
  const origText = btn ? btn.textContent : '';
  if (btn) { btn.textContent = '...'; btn.disabled = true; }

  // BGM pause
  const bgmWasPlaying = (typeof BGM_STATE !== 'undefined') && BGM_STATE.isPlaying;
  if (bgmWasPlaying && BGM_STATE.audioEl) { BGM_STATE.audioEl.pause(); BGM_STATE.isPlaying = false; }

  try {
    let cached = _ttsVoiceCache.get(cacheKey);

    if (!cached) {
      if (btn) btn.textContent = '获取';
      const provider = ttsCollectFormProvider();
      const resp = await fetch('/api/tts/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...provider, voice, text: '你好，这是' + (sel.selectedOptions[0]?.textContent || '该音色') + '的试听样本。', ...(testInstruct ? { instruction: testInstruct } : {}) })
      });
      if (!resp.ok) {
        const errText = await resp.text();
        throw new Error(`HTTP ${resp.status}: ${errText.substring(0, 100)}`);
      }
      const blob = await resp.blob();
      if (blob.size < 100) throw new Error('音频过小');
      const blobUrl = URL.createObjectURL(blob);
      const audio = new Audio(blobUrl);
      cached = { blobUrl, audio };
      _ttsVoiceCache.set(cacheKey, cached);
    }

    if (btn) btn.textContent = '播放';

    _ttsVoiceTestAudio = cached.audio;
    _ttsVoiceTestAudio.currentTime = 0;
    _ttsVoiceTestAudio.volume = 1.0;

    _ttsVoiceTestAudio.onended = () => {
      if (btn) { btn.textContent = origText; btn.disabled = false; }
      if (bgmWasPlaying && BGM_STATE.enabled && BGM_STATE.audioEl) {
        setTimeout(() => BGM_STATE.audioEl.play().catch(() => { }), 300);
      }
    };
    _ttsVoiceTestAudio.onerror = () => {
      if (btn) { btn.textContent = origText; btn.disabled = false; }
      // Invalidate broken cache
      _ttsVoiceCache.delete(cacheKey);
    };

    await _ttsVoiceTestAudio.play();
    if (btn) btn.textContent = '⏸';
  } catch (e) {
    console.error('[TTS] Voice test error:', e);
    showToast('试听失败: ' + e.message.substring(0, 80), 'error', 3000);
    if (btn) { btn.textContent = origText; btn.disabled = false; }
    if (bgmWasPlaying && BGM_STATE.enabled && BGM_STATE.audioEl) BGM_STATE.audioEl.play().catch(() => { });
  }
}

// --- Segment text helpers (shared between old & new) ---

function ttsExtractText(segments) {
  const narrateOn = document.getElementById('ttsNarrateNarration')?.checked;
  const parts = [];
  for (const seg of segments) {
    const text = (seg.text || '').trim();
    if (!text || text.length < 2) continue;
    if (seg.type === 'story') {
      if (!narrateOn) continue;
      const cleaned = text.replace(/=== \u72b6\u6001\u680f ===[\s\S]*$/i, '').replace(/^\s*--?\d+[.\u3001\s].*$/gm, '').trim();
      if (cleaned) parts.push(cleaned);
    } else if (seg.type === 'dialog' || seg.type === 'dialogue') {
      // Only read dialog text, skip speaker name (name field)
      parts.push(text);
    }
  }
  return parts.join('\n');
}

/** Split text into chunks ≤ maxChars, by natural paragraph breaks */
function ttsSplitText(text, maxChars = 900) {
  const paragraphs = text.split(/\n+/).filter(p => p.trim());
  const chunks = [];
  let current = '';
  for (const para of paragraphs) {
    if (para.length > maxChars) {
      // Paragraph itself too long: split by sentences
      if (current) { chunks.push(current); current = ''; }
      const sentences = para.split(/(?<=[。！？!?；;])/);
      for (const s of sentences) {
        if ((current + s).length > maxChars) {
          if (current) chunks.push(current);
          current = s;
          // If single sentence > maxChars, hard split
          while (current.length > maxChars) {
            chunks.push(current.substring(0, maxChars));
            current = current.substring(maxChars);
          }
        } else {
          current += s;
        }
      }
    } else if ((current + '\n' + para).length > maxChars) {
      if (current) chunks.push(current);
      current = para;
    } else {
      current = current ? current + '\n' + para : para;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/** 旁白专用：按【自然段(回车)】严格切分 —— 每个非空段落都是一条独立 TTS 请求。
 *  与 ttsSplitText 不同，这里【绝不把多个段落合并】成一条（ttsSplitText 会把相邻短段
 *  攒到 900 字符才发，导致多条短旁白被并成一条超长请求、生成耗时爆增）。
 *  自回归 TTS 的单条生成成本随长度近似平方增长，把长旁白拆成短段落可显著缩短
 *  单条与总生成耗时，并避免单条过长触发后端 600s 超时。
 *  仅当某个【单段本身】超过 maxChars 时，才对该段内部做句/硬切兜底，不让单条请求失控。 */
function ttsSplitByParagraph(text, maxChars = 900) {
  const paras = (text || '').split(/\n+/).map(p => p.trim()).filter(Boolean);
  const chunks = [];
  for (const para of paras) {
    if (para.length <= maxChars) {
      chunks.push(para);
    } else {
      // 单段过长：复用按句/硬切逻辑兜底，避免一条请求过长
      for (const sub of ttsSplitText(para, maxChars)) chunks.push(sub);
    }
  }
  return chunks;
}

/** 确保 TTS 所需的【详细名册】已就绪。
 *  TTS 声线解析依赖 AppState.characterRoster 为「按角色全名 key 的对象(含 种族性别/年龄)」。
 *  但在 TTS 触发时机，该状态可能为空 {}（例如 loadConversation 时未匹配到存档），
 *  导致所有对白回落旁白声线、角色失去各自音色。此处主动校验并兜底拉取详细名册。
 *  @returns {Promise<boolean>} true 表示已拿到可用名册。 */
async function ttsEnsureRoster() {
  // 校验名册是否为「含性别/年龄字段的详细对象」
  const hasDetail = (r) => r && typeof r === 'object' && !Array.isArray(r) &&
    Object.values(r).some(e => e && (e['\u79cd\u65cf\u6027\u522b'] || e['\u5e74\u9f84']));
  if (hasDetail(AppState.characterRoster)) {
    console.log('[TTS] ttsEnsureRoster: 名册已就绪, 角色数=', Object.keys(AppState.characterRoster).length);
    return true; // 已是有效详细名册，无需拉取
  }
  if (Array.isArray(AppState.characterRoster)) {
    console.warn('[TTS] ttsEnsureRoster: 名册当前是名字数组(无详情字段)，需主动拉取详细名册');
  }

  // 主路径：按 conversation_id 拉取【详细名册】(后端跨所有 save 匹配角色名，最稳)
  const convId = AppState.currentConversation?.id;
  if (convId) {
    try {
      const resp = await request('/conversations/' + convId + '/roster').catch(() => null);
      if (resp && resp.roster && hasDetail(resp.roster)) {
        AppState.characterRoster = resp.roster;
        console.log('[TTS] ttsEnsureRoster: 已按 conversation_id 拉取详细名册, 角色数=', Object.keys(resp.roster).length);
        return true;
      }
      console.warn('[TTS] ttsEnsureRoster: conversation 名册无详情字段, keys=', resp && resp.roster ? Object.keys(resp.roster).length : 'null');
    } catch (e) { console.warn('[TTS] ttsEnsureRoster: 拉取 conversation 名册失败', e.message); }
  } else {
    console.warn('[TTS] ttsEnsureRoster: 无 currentConversation.id，无法按对话拉取名册');
  }

  // 兜底：按 _currentSaveId 直接拉取(save 级详细名册)
  let saveId = AppState._currentSaveId || '';
  if (!saveId && AppState.currentConversation?.id) {
    try {
      const saves = await SavesAPI.list().catch(() => []);
      const save = saves.find(s => s.conversation_id === AppState.currentConversation.id)
        || (AppState.currentCharacter?.id ? saves.find(s => s.character_id === AppState.currentCharacter.id) : null);
      if (save) saveId = save.id;
    } catch { /* ignore */ }
  }
  if (saveId) {
    try {
      const resp = await request('/saves/' + saveId + '/roster').catch(() => null);
      if (resp && resp.roster && hasDetail(resp.roster)) {
        AppState.characterRoster = resp.roster;
        console.log('[TTS] ttsEnsureRoster: 已按 save 兜底拉取, 角色数=', Object.keys(resp.roster).length);
        return true;
      }
    } catch { /* ignore */ }
  }
  console.warn('[TTS] ttsEnsureRoster: 全部路径未能取得详细名册，对白将回落旁白声线');
  return false;
}

/** 从名册抓取性别+年龄，配合声音映射设定，解析出【声线/voice】(speaker)。
 *  返回 { voice, category }；名册中无该角色或性别不可用则返回 null（交由旁白声线兜底）。
 *  ⚠️ 仅负责"声线"的规范；语气(tone)由 AI 分析剧情后通过 seg.mood 提供，二者分离、互不影响。 */
function ttsResolveVoiceForChar(name, roster, voiceMap) {
  if (!name || !voiceMap) return null;
  // 优先精确匹配；名册无该角色时走模糊查找（兼容叙事用简称 vs 名册全名，如"汤姆"↔"汤姆·里德尔"）
  let char = (roster && typeof roster === 'object' && !Array.isArray(roster)) ? roster[name] : null;
  if (!char) {
    const found = lookupRosterEntry(name);
    if (found) char = found.entry;
  }
  if (!char) {
    if (roster && !Array.isArray(roster) && Object.keys(roster).length) {
      console.warn('[TTS] 声线解析失败: 角色「' + name + '」不在名册, 名册现有=', Object.keys(roster).join(' | '));
    }
    return null; // 名册中无此角色
  }
  // ---- 显式转换名册原始字段为性别/年龄参数 ----
  // 名册原始存储格式(为方便生图 Tga 设计)：
  //   种族性别: "human_girl" / "human_boy" / "female" / "male" ...
  //   年龄:     "35_years_old" / "20_years_old" / "18" ...
  // 这里统一规范化为 { isFemale / isMale / age }，再映射声线分类。
  const genderRaw = String(char['\u79cd\u65cf\u6027\u522b'] || char['gender'] || char['\u6027\u522b'] || '').toLowerCase();
  const ageRaw = String(char['\u5e74\u9f84'] || char['age'] || '');
  // 性别：剥离 human_ 等前缀，按核心 token 判定
  let isFemale = false, isMale = false;
  if (/(girl|female|woman|lady|she|ms|miss|\u6bcd)/.test(genderRaw)) isFemale = true;
  else if (/(boy|male|man|gentleman|he|mr|\u516c)/.test(genderRaw)) isMale = true;
  // 年龄：提取首个数字("35_years_old" -> 35)
  const ageMatch = ageRaw.match(/(\d+)/);
  const age = ageMatch ? parseInt(ageMatch[1], 10) : 25;
  let category = null;
  if (isFemale) {
    if (age < 18) category = 'female_teen';
    else if (age <= 30) category = 'female_young';
    else category = 'female_mature';
  } else if (isMale) {
    if (age < 18) category = 'male_teen';
    else if (age <= 30) category = 'male_young';
    else category = 'male_mature';
  }
  if (!category) return null; // 名册无可用性别信息
  // 声线：优先用该分类映射的声线；未配置则回落到旁白声线，保持音色稳定
  const voice = voiceMap[category] || voiceMap.narrator || null;
  return { voice, category };
}

/** 旁白固定提示词：锁定旁白音色，避免空 instruct 漂移。亦作为名册缺角色时的兜底提示。 */
const TTS_NARRATOR_INSTRUCTION = '\u7528\u7ed8\u58f0\u7ed8\u8272\u7684\u8bb2\u6545\u4e8b\u8bed\u6c14\u6717\u8bfb';

/** 对白语气兜底：当 AI 未给出情绪( seg.mood 为空 )时使用，确保 instruct 永不为空，
 *  避免 Qwen3-TTS 空 instruct 的随机漂移。AI 给出情绪时以 AI 为准。 */
const TTS_DIALOG_NEUTRAL_INSTRUCTION = '\u7528\u81ea\u7136\u5e73\u7a33\u7684\u8bed\u6c14\u6717\u8bfb';

/** 音色特征描述（自然语言），按声音映射分类组织。
 *  写入 instruct —— Qwen3-TTS CustomVoice 的【主控制字段】(参考 TTS 服务说明文档: instruct=声音特征描述, 必填)。
 *  全部以「用…」开头，确保后端 buildEmotionInstruction() 原样透传、不会被误包裹成情绪短语。 */
const VOICE_DESC = {
  female_teen:   '用清脆活泼的少女声线',
  female_young:  '用清亮甜美的年轻女声',
  female_mature: '用成熟温柔的女声',
  male_teen:     '用清朗干净的少年声线',
  male_young:    '用清爽利落的年轻男声',
  male_mature:   '用低沉稳重的男声',
};

/** ComfyUI Qwen3-TTS VoiceDesign 模式下的【12 类声音标签】。
 *  男声 6 种 / 女声 6 种，用户在「角色音色映射」中按性别+年龄分类挑选其一作为 voice。
 *  voice_description = 「所选标签类型 + AI 当场给出的情绪」由后端 buildComfyVoiceDesc 拼接。 */
const COMFY_MALE_LABELS = ['沉稳专业', '温暖治愈', '活力阳光', '冷峻神秘', '儒雅学者', '痞帅不羁'];
const COMFY_FEMALE_LABELS = ['知性优雅', '甜美少女', '御姐干练', '空灵仙气', '泼辣市井', '冷艳疏离'];
const COMFY_ALL_LABELS = [...COMFY_MALE_LABELS, ...COMFY_FEMALE_LABELS];

/** 在 comfyui 模式下，把 7 个角色音色映射下拉框 + 主音色下拉框填充为 12 类中文标签
 *  （女声分类→6 个女声标签，男声分类→6 个男声标签，旁白→全部 12 个，主音色→全部 12 个）。 */
function ttsPopulateComfyLabels() {
  const femaleOpts = COMFY_FEMALE_LABELS.map(l => `<option value="${l}">${l}</option>`).join('');
  const maleOpts = COMFY_MALE_LABELS.map(l => `<option value="${l}">${l}</option>`).join('');
  const allOpts = COMFY_ALL_LABELS.map(l => `<option value="${l}">${l}</option>`).join('');
  const fill = (id, optsHtml) => {
    const el = document.getElementById(id);
    if (!el) return;
    const saved = el.value;
    el.innerHTML = '<option value="">(默认)</option>' + optsHtml;
    if (saved && (optsHtml.includes(`value="${saved}"`) || saved === '')) el.value = saved;
  };
  fill('ttsVm_narrator', allOpts);
  fill('ttsVm_female_teen', femaleOpts);
  fill('ttsVm_female_young', femaleOpts);
  fill('ttsVm_female_mature', femaleOpts);
  fill('ttsVm_male_teen', maleOpts);
  fill('ttsVm_male_young', maleOpts);
  fill('ttsVm_male_mature', maleOpts);
  fill('ttsProviderVoice', allOpts);
}

/** 当 AI 未给出 seg.mood 时，按对白文本做轻量情绪推断，仅作兜底让 instruct 语气不退化。
 *  兜底也输出完整语气短语，与 AI 提供的风格一致，便于 TTS 服务器识别。 */
function inferEmotionFromText(t) {
  if (!t) return '';
  if (/[！!]/.test(t)) return '激动地喊道';
  if (/[？?]/.test(t)) return '疑惑地问道';
  if (/……|\.\.\.|。{2,}/.test(t)) return '低沉地叹息';
  if (/[~～]/.test(t)) return '慵懒地呢喃';
  return '';
}

/** Build per-segment TTS tasks.
 *  声线(voice)：代码按名册性别+年龄 → 声音映射分类（不经 AI）；名册缺角色则回落旁白声线。
 *  语气(tone)：由 AI 分析剧情经 seg.mood 提供，不在本处生成（空时用中性兜底防漂移）。
 *  format === 'comfyui' (Qwen3-TTS VoiceDesign)：voice=用户在映射中挑的 12 类标签之一（已含类型），
 *    emotion=仅 AI 情绪短语（后端 buildComfyVoiceDesc 会把「类型 + 情绪」拼成 voice_description）。 */
/** 判断一段文本是否含有可朗读的「文字」（字母 / CJK / 数字），而非纯标点、符号或空白。
 *  纯符号段落（如分隔线 ---、……）不应发起 TTS 请求，避免浪费配额并产生无意义静音。 */
function ttsHasReadableText(text) {
  if (!text) return false;
  const stripped = String(text).replace(/\s+/g, '');
  if (!stripped) return false;
  return /[\p{L}\p{N}]/u.test(stripped);
}

function ttsBuildTasks(segments, roster, voiceMap, format) {
  const isComfy = (format === 'comfyui');
  const narrateOn = document.getElementById('ttsNarrateNarration')?.checked;
  const segTypes = segments.map(s => s.type);
  console.log('[TTS] BuildTasks: format=', format, 'narrateOn=', narrateOn, 'segmentTypes=', segTypes, 'segments=', segments.length);
  const tasks = [];
  for (const seg of segments) {
    const text = (seg.text || '').trim();
    if (!text || text.length < 2) continue;
    let voice = null;
    let cleanText = text;
    let emotion = null;
    if (seg.type === 'story') {
      if (!narrateOn) continue;
      cleanText = text.replace(/=== \u72b6\u6001\u680f ===[\s\S]*$/i, '').replace(/^\s*--?\d+[.\u3001\s].*$/gm, '').trim();
      if (!cleanText) continue;
      voice = voiceMap?.narrator || null;
      if (isComfy) {
        // ComfyUI：旁白 voice 缺省时后端回落「沉稳大气的旁白男声」；emotion 仅 AI 情绪（无则空）
        emotion = (seg.mood || '').trim() || '';
      } else {
        // 旁白固定提示词（锁定旁白音色，避免空 instruct 漂移）
        emotion = voiceMap?.instruct_narrator || TTS_NARRATOR_INSTRUCTION;
      }
    } else if (seg.type === 'dialog' || seg.type === 'dialogue') {
      // 声线：代码从名册抓取性别+年龄 → 声音映射分类（不经 AI，规范声线）
      // 兼容多种字段命名（后端 fmt.segments 用 name，前端渲染段用 speaker）
      const charName = seg.name || seg.speaker || seg.character || '';
        const resolved = ttsResolveVoiceForChar(charName, roster, voiceMap);
        voice = (resolved && resolved.voice) ? resolved.voice : (voiceMap?.narrator || null);
        const cat = resolved ? resolved.category : null;
        // 语气: 优先 AI 的 seg.mood; 缺失时轻量文本推断兜底, 避免 instruct 退化为中性
        let mood = (seg.mood || '').trim();
        if (!mood) mood = inferEmotionFromText(cleanText);
        const moodPhrase = mood || '';
        if (isComfy) {
          // ComfyUI VoiceDesign：voice 已是「类型标签」(如「甜美少女」)，后端据此生成
          // 「一个甜美少女的女声」并拼接情绪；emotion 仅传情绪短语，切勿再拼 VOICE_DESC。
          emotion = moodPhrase || '';
        } else {
          // 音色特征描述: 性别+年龄分类 → 自然语言, 写入 instruct (Qwen3-TTS 主控制字段)
          const voiceDesc = cat ? (VOICE_DESC[cat] || '') : '';
          // 注意: 包裹成"用X的语气"由【后端 buildEmotionInstruction()】统一处理(tts.js:559);
          // 前端只传原始情绪词(激动/疑惑/...)或 AI 给的完整短语(含「用」则后端原样透传)。
          emotion = (voiceDesc && moodPhrase) ? (voiceDesc + '，' + moodPhrase)
                  : (voiceDesc || moodPhrase || TTS_DIALOG_NEUTRAL_INSTRUCTION);
        }
        console.log('[TTS] 对白 charName=', charName,
          '→ category=', cat || '(无匹配/回落旁白)',
          '→ voice=', voice, '→ instruct=', emotion, '| 名册角色=', Object.keys(roster || {}).join(' | '));
    } else {
      continue; // 其它类型（状态栏等）跳过
    }
    // 切分粒度：旁白按【自然段(回车)】逐段发送（每段一条请求），对白沿用字符/句切分。
    // 自回归 TTS 生成成本约随长度平方增长，旁白拆短段可显著缩短单条与总生成耗时，
    // 并避免单条过长触发后端超时。
    const chunks = (seg.type === 'story')
      ? ttsSplitByParagraph(cleanText, 900)
      : ttsSplitText(cleanText, 900);
    for (const chunk of chunks) {
      // 纯标点/符号段落（如 --- 分隔线）跳过语音请求：无文字可读，合成无意义
      if (!ttsHasReadableText(chunk)) {
        console.log('[TTS] skip punctuation-only chunk, no TTS request:', JSON.stringify(chunk.slice(0, 40)));
        continue;
      }
      tasks.push({ text: chunk, voice, emotion, narrator: seg.type === 'story' });
    }
  }
  return tasks;
}

// --- New async entry point: submit segments to buffer ---

/** Called when AI response arrives. Submits segments to TTSBuffer (async from text render). */
async function ttsPlaySegments(segments, context) {
  if (!ttsMasterEnabled()) return;
  if (!document.getElementById('ttsAutoPlay')?.checked) return;
  if (!segments || segments.length === 0) return;

  // Queue behind any in-progress playback so a new AI reply never interrupts the
  // sentence currently being read. The player auto-advances through the queue.
  ttsPlayer.enqueueOrPlay(segments, context);
}

/** Replay a specific message's TTS */
function ttsReplayMessage(msgDiv) {
  const segsJson = msgDiv.dataset.ttsSegments;
  if (!segsJson) { alert('\u8be5\u6d88\u606f\u6ca1\u6709\u53ef\u6717\u8bfb\u7684\u6bb5\u843d'); return; }
  try {
    ttsPlaySegments(JSON.parse(segsJson), { msgDiv, gameName: msgDiv.dataset.ttsCacheGame, turn: msgDiv.dataset.ttsCacheTurn });
  } catch (e) { console.error('[TTS] Replay:', e); }
}
