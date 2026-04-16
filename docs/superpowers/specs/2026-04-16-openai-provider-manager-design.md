# OpenAI API 供应商管理浏览器插件设计文档

**日期：** 2026-04-16  
**版本：** 1.0

## 概述

一个 Chrome 浏览器插件，用于管理多个 OpenAI 兼容 API 供应商，支持快速切换、测试连接、导入导出配置等功能。主要面向开发者，用于在开发调试时快速切换不同的 API 供应商。

## 目标用户

需要在开发过程中测试多个 OpenAI 兼容 API 供应商的开发者。

## 核心功能

1. **供应商管理**：添加、编辑、删除供应商配置
2. **快速切换**：在多个供应商之间快速切换激活状态
3. **连接测试**：发送实际 API 请求验证供应商可用性
4. **导入导出**：导入/导出供应商配置为 JSON 文件
5. **状态显示**：显示每个供应商的测试状态和最后测试时间

## 架构设计

### 整体架构

```
┌─────────────────┐
│  Popup 界面      │ ← 快速切换供应商、快速测试
└────────┬────────┘
         │
┌────────▼────────┐
│  Options 页面    │ ← 完整的供应商管理
└────────┬────────┘
         │
┌────────▼────────┐
│  Background     │ ← 处理 API 请求、状态管理
│  Service Worker │
└────────┬────────┘
         │
┌────────▼────────┐
│  Chrome Storage │ ← 持久化存储供应商数据
└─────────────────┘
```

### 核心模块

#### Popup 界面
- 显示当前激活供应商及状态
- 供应商列表（单选切换）
- 快速测试按钮
- 跳转到 Options 页面按钮

#### Options 页面
- 供应商列表展示
- 添加/编辑/删除供应商
- 导入/导出配置
- 查看测试状态详情

#### Background Service Worker
- 处理 API 测试请求
- 管理供应商状态
- 响应 Popup 和 Options 的消息

#### Storage
- 使用 `chrome.storage.local` 持久化存储
- 存储供应商配置和状态信息

## 数据模型

### Provider（供应商）

```typescript
interface Provider {
  id: string;              // 唯一标识（UUID）
  name: string;            // 供应商名称
  baseUrl: string;         // API base URL
  apiKey: string;          // API Key
  isActive: boolean;       // 是否为当前激活供应商
  testStatus?: {           // 测试状态（可选）
    lastTestTime: number;  // 最后测试时间戳
    isSuccess: boolean;    // 是否成功
    errorMessage?: string; // 错误信息（失败时）
  };
  createdAt: number;       // 创建时间戳
  updatedAt: number;       // 更新时间戳
}
```

### StorageData（存储数据）

```typescript
interface StorageData {
  providers: Provider[];            // 供应商列表
  activeProviderId: string | null;  // 当前激活的供应商 ID
}
```

## UI 设计

### Popup 界面

尺寸：300x400px

```
┌─────────────────────────────┐
│ 当前供应商: OpenAI          │
│ 状态: ✓ 已验证 (2小时前)    │
├─────────────────────────────┤
│ 供应商列表                   │
│ ┌─────────────────────────┐ │
│ │ ○ OpenAI        [测试]  │ │
│ │   api.openai.com        │ │
│ ├─────────────────────────┤ │
│ │ ● DeepSeek      [测试]  │ │
│ │   api.deepseek.com      │ │
│ └─────────────────────────┘ │
├─────────────────────────────┤
│ [快速测试]  [管理供应商]    │
└─────────────────────────────┘
```

**交互说明：**
- 点击单选按钮切换激活供应商
- 点击"测试"按钮测试单个供应商
- 点击"快速测试"测试当前激活供应商
- 点击"管理供应商"打开 Options 页面

### Options 页面

```
┌─────────────────────────────────────┐
│ 供应商管理                          │
├─────────────────────────────────────┤
│ [+ 添加供应商] [导入] [导出]        │
├─────────────────────────────────────┤
│ 供应商列表                          │
│ ┌─────────────────────────────────┐ │
│ │ OpenAI                          │ │
│ │ URL: api.openai.com             │ │
│ │ 状态: ✓ 已验证 (2024-01-15)     │ │
│ │ [编辑] [删除] [测试]             │ │
│ ├─────────────────────────────────┤ │
│ │ DeepSeek                        │ │
│ │ URL: api.deepseek.com           │ │
│ │ 状态: ✗ 失败 (连接超时)          │ │
│ │ [编辑] [删除] [测试]             │ │
│ └─────────────────────────────────┘ │
└─────────────────────────────────────┘
```

**交互说明：**
- 点击"添加供应商"打开添加对话框
- 点击"导入"选择 JSON 配置文件
- 点击"导出"下载当前配置为 JSON 文件
- 每个供应商卡片显示名称、URL、状态和操作按钮

### 添加/编辑供应商对话框

```
┌─────────────────────────────┐
│ 添加供应商                  │
├─────────────────────────────┤
│ 供应商名称:                 │
│ [___________________]       │
│                             │
│ Base URL:                   │
│ [___________________]       │
│                             │
│ API Key:                    │
│ [___________________] [👁]  │
│                             │
│ [取消]  [保存并测试]        │
└─────────────────────────────┘
```

**交互说明：**
- 点击"👁"切换 API Key 显示/隐藏
- 点击"保存并测试"保存后立即测试连接
- 点击"取消"关闭对话框不保存

## API 集成

### 测试 API 请求

**请求配置：**
```typescript
{
  method: 'POST',
  url: `${baseUrl}/v1/chat/completions`,
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`
  },
  body: {
    model: 'gpt-3.5-turbo',
    messages: [{ role: 'user', content: 'Hi' }],
    max_tokens: 10
  },
  timeout: 10000  // 10秒超时
}
```

**响应处理：**
- 成功（200）：更新测试状态为成功
- 认证失败（401）：提示 Invalid API Key
- 权限不足（403）：提示 Insufficient quota
- 服务器错误（500）：提示 Server error
- 网络错误：提示 Connection failed
- 超时：提示 Request timeout

### 错误处理

| 错误类型 | 错误信息 | 处理方式 |
|---------|---------|---------|
| 网络错误 | Connection failed | 更新状态为失败 |
| 认证错误 | Invalid API Key | 更新状态为失败 |
| 权限错误 | Insufficient quota | 更新状态为失败 |
| 服务器错误 | Server error | 更新状态为失败 |
| 超时 | Request timeout | 更新状态为失败 |
| 其他错误 | Unknown error | 更新状态为失败 |

## 存储与安全

### 存储方案

- **存储位置：** `chrome.storage.local`
- **存储容量：** 无限制
- **数据持久化：** 浏览器关闭后仍保留

### 安全考虑

1. **API Key 保护**
   - 存储在 `chrome.storage.local`，仅插件可访问
   - 不在控制台或日志中输出 API Key
   - UI 中默认隐藏 API Key，需点击才显示

2. **导入导出安全**
   - 导出时提示用户妥善保管配置文件
   - 导入时验证 JSON 格式和必需字段
   - 不验证 API Key 有效性（由用户自行确认）

3. **权限控制**
   - 仅请求必要的 `storage` 权限
   - 不请求访问用户浏览数据的权限

### 导入导出格式

```json
{
  "version": "1.0",
  "exportedAt": "2024-01-15T10:30:00Z",
  "providers": [
    {
      "name": "OpenAI",
      "baseUrl": "https://api.openai.com",
      "apiKey": "sk-..."
    }
  ]
}
```

**字段说明：**
- `version`：配置文件版本
- `exportedAt`：导出时间（ISO 8601 格式）
- `providers`：供应商列表
  - `name`：供应商名称
  - `baseUrl`：API base URL
  - `apiKey`：API Key

## 技术栈

### 核心技术

- **Manifest V3**：Chrome 扩展最新标准
- **TypeScript**：类型安全
- **React 18**：UI 组件开发
- **Tailwind CSS**：样式框架
- **Vite**：构建工具

### Chrome APIs

- `chrome.storage`：数据存储
- `chrome.runtime`：消息通信
- `chrome.tabs`：打开 Options 页面

## 文件结构

```
CodexSwitch/
├── src/
│   ├── popup/              # Popup 界面
│   │   ├── App.tsx
│   │   ├── index.tsx
│   │   └── style.css
│   ├── options/            # Options 页面
│   │   ├── App.tsx
│   │   ├── index.tsx
│   │   └── style.css
│   ├── background/         # Background Service Worker
│   │   └── index.ts
│   ├── components/         # 共享组件
│   │   ├── ProviderCard.tsx
│   │   ├── ProviderForm.tsx
│   │   └── StatusBadge.tsx
│   ├── utils/              # 工具函数
│   │   ├── storage.ts      # 存储操作
│   │   ├── api.ts          # API 测试
│   │   └── export.ts       # 导入导出
│   └── types/              # TypeScript 类型定义
│       └── index.ts
├── public/
│   ├── manifest.json       # 扩展配置
│   ├── icon.png           # 扩展图标
│   └── popup.html
├── package.json
├── tsconfig.json
├── vite.config.ts
└── tailwind.config.js
```

## 开发计划

### 阶段 1：基础架构
- 初始化项目结构
- 配置构建工具
- 实现 TypeScript 类型定义
- 实现存储工具函数

### 阶段 2：核心功能
- 实现 Background Service Worker
- 实现 API 测试功能
- 实现供应商管理逻辑

### 阶段 3：UI 开发
- 开发共享组件
- 开发 Popup 界面
- 开发 Options 页面

### 阶段 4：完善功能
- 实现导入导出功能
- 优化错误处理
- 添加加载状态和提示

### 阶段 5：测试与优化
- 功能测试
- 性能优化
- 用户体验优化

## 限制与约束

1. **浏览器支持：** 仅支持 Chrome 浏览器（Manifest V3）
2. **API 兼容性：** 仅支持 OpenAI 兼容 API（使用 `/v1/chat/completions` 端点）
3. **测试请求：** 使用固定的测试消息"Hi"和模型"gpt-3.5-turbo"
4. **存储限制：** 依赖 `chrome.storage.local` 的存储限制

## 未来扩展

以下功能不在当前版本范围内，但可在未来考虑：

1. **自定义测试请求：** 允许用户自定义测试消息和模型
2. **批量测试：** 一键测试所有供应商
3. **使用统计：** 记录每个供应商的使用次数和成功率
4. **快捷键支持：** 使用键盘快捷键快速切换供应商
5. **主题切换：** 支持亮色/暗色主题
6. **多语言支持：** 支持中文/英文切换
