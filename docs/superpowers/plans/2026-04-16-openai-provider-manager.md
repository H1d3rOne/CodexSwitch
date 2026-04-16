# OpenAI API 供应商管理浏览器插件实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 构建一个 Chrome 浏览器插件，用于管理多个 OpenAI 兼容 API 供应商，支持快速切换、测试连接、导入导出配置。

**架构：** 采用 Chrome Extension Manifest V3 架构，包含 Popup 界面（快速切换）、Options 页面（完整管理）、Background Service Worker（API 测试）三个核心模块，使用 chrome.storage.local 持久化数据。

**技术栈：** TypeScript, React 18, Tailwind CSS, Vite, Chrome Extension APIs

---

## 文件结构

```
CodexSwitch/
├── src/
│   ├── types/
│   │   └── index.ts                    # TypeScript 类型定义
│   ├── utils/
│   │   ├── storage.ts                  # 存储操作工具
│   │   ├── api.ts                      # API 测试工具
│   │   ├── export.ts                   # 导入导出工具
│   │   └── uuid.ts                     # UUID 生成工具
│   ├── background/
│   │   └── index.ts                    # Background Service Worker
│   ├── components/
│   │   ├── StatusBadge.tsx             # 状态徽章组件
│   │   ├── ProviderCard.tsx            # 供应商卡片组件
│   │   └── ProviderForm.tsx            # 供应商表单组件
│   ├── popup/
│   │   ├── index.tsx                   # Popup 入口
│   │   ├── App.tsx                     # Popup 主组件
│   │   └── style.css                   # Popup 样式
│   └── options/
│       ├── index.tsx                   # Options 入口
│       ├── App.tsx                     # Options 主组件
│       └── style.css                   # Options 样式
├── public/
│   ├── manifest.json                   # 扩展配置文件
│   ├── popup.html                      # Popup HTML
│   ├── options.html                    # Options HTML
│   └── icon.png                        # 扩展图标
├── tests/
│   ├── utils/
│   │   ├── storage.test.ts             # 存储工具测试
│   │   ├── api.test.ts                 # API 工具测试
│   │   └── export.test.ts              # 导入导出测试
│   └── components/
│       ├── StatusBadge.test.tsx        # 状态徽章测试
│       ├── ProviderCard.test.tsx       # 供应商卡片测试
│       └── ProviderForm.test.tsx       # 供应商表单测试
├── package.json                        # 项目配置
├── tsconfig.json                       # TypeScript 配置
├── vite.config.ts                      # Vite 构建配置
├── tailwind.config.js                  # Tailwind 配置
├── postcss.config.js                   # PostCSS 配置
└── vitest.config.ts                    # Vitest 测试配置
```

---

## 阶段 1：基础架构

### 任务 1：初始化项目结构

**文件：**
- 创建：`package.json`
- 创建：`tsconfig.json`
- 创建：`.gitignore`

- [ ] **步骤 1：创建 package.json**

```json
{
  "name": "codex-switch",
  "version": "1.0.0",
  "description": "OpenAI API Provider Manager Chrome Extension",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "test": "vitest",
    "test:ui": "vitest --ui",
    "lint": "eslint src --ext ts,tsx --report-unused-disable-directives --max-warnings 0"
  },
  "dependencies": {
    "react": "^18.2.0",
    "react-dom": "^18.2.0"
  },
  "devDependencies": {
    "@types/chrome": "^0.0.260",
    "@types/react": "^18.2.43",
    "@types/react-dom": "^18.2.17",
    "@typescript-eslint/eslint-plugin": "^6.14.0",
    "@typescript-eslint/parser": "^6.14.0",
    "@vitejs/plugin-react": "^4.2.1",
    "@vitest/ui": "^1.1.0",
    "autoprefixer": "^10.4.16",
    "eslint": "^8.55.0",
    "eslint-plugin-react-hooks": "^4.6.0",
    "eslint-plugin-react-refresh": "^0.4.5",
    "postcss": "^8.4.32",
    "tailwindcss": "^3.4.0",
    "typescript": "^5.2.2",
    "vite": "^5.0.8",
    "vitest": "^1.1.0",
    "@testing-library/react": "^14.1.2",
    "@testing-library/jest-dom": "^6.1.5",
    "jsdom": "^23.0.1"
  }
}
```

- [ ] **步骤 2：创建 tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "useDefineForClassFields": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "types": ["chrome", "vite/client"]
  },
  "include": ["src"],
  "references": [{ "path": "./tsconfig.node.json" }]
}
```

- [ ] **步骤 3：创建 tsconfig.node.json**

```json
{
  "compilerOptions": {
    "composite": true,
    "skipLibCheck": true,
    "module": "ESNext",
    "moduleResolution": "bundler",
    "allowSyntheticDefaultImports": true
  },
  "include": ["vite.config.ts", "vitest.config.ts"]
}
```

- [ ] **步骤 4：创建 .gitignore**

```
node_modules/
dist/
.DS_Store
*.log
.env
.vitest/
```

- [ ] **步骤 5：安装依赖**

运行：`npm install`

预期：成功安装所有依赖

- [ ] **步骤 6：Commit**

```bash
git add package.json tsconfig.json tsconfig.node.json .gitignore
git commit -m "chore: initialize project with dependencies"
```

---

### 任务 2：配置构建工具

**文件：**
- 创建：`vite.config.ts`
- 创建：`vitest.config.ts`
- 创建：`tailwind.config.js`
- 创建：`postcss.config.js`

- [ ] **步骤 1：创建 vite.config.ts**

```typescript
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: {
        popup: resolve(__dirname, 'public/popup.html'),
        options: resolve(__dirname, 'public/options.html'),
        background: resolve(__dirname, 'src/background/index.ts'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name].js',
        assetFileNames: 'assets/[name].[ext]',
      },
    },
  },
})
```

- [ ] **步骤 2：创建 vitest.config.ts**

```typescript
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './tests/setup.ts',
  },
})
```

- [ ] **步骤 3：创建 tests/setup.ts**

```typescript
import '@testing-library/jest-dom'
```

- [ ] **步骤 4：创建 tailwind.config.js**

```javascript
/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./src/**/*.{js,ts,jsx,tsx}",
    "./public/**/*.{html}",
  ],
  theme: {
    extend: {},
  },
  plugins: [],
}
```

- [ ] **步骤 5：创建 postcss.config.js**

```javascript
export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
}
```

- [ ] **步骤 6：Commit**

```bash
git add vite.config.ts vitest.config.ts tailwind.config.js postcss.config.js tests/setup.ts
git commit -m "chore: configure build tools"
```

---

### 任务 3：实现 TypeScript 类型定义

**文件：**
- 创建：`src/types/index.ts`
- 测试：`tests/types/index.test.ts`

- [ ] **步骤 1：编写类型定义**

```typescript
export interface TestStatus {
  lastTestTime: number
  isSuccess: boolean
  errorMessage?: string
}

export interface Provider {
  id: string
  name: string
  baseUrl: string
  apiKey: string
  isActive: boolean
  testStatus?: TestStatus
  createdAt: number
  updatedAt: number
}

export interface StorageData {
  providers: Provider[]
  activeProviderId: string | null
}

export interface ExportData {
  version: string
  exportedAt: string
  providers: Array<{
    name: string
    baseUrl: string
    apiKey: string
  }>
}

export interface TestResult {
  success: boolean
  message: string
  error?: string
}

export type MessageType = 
  | 'GET_PROVIDERS'
  | 'ADD_PROVIDER'
  | 'UPDATE_PROVIDER'
  | 'DELETE_PROVIDER'
  | 'SET_ACTIVE_PROVIDER'
  | 'TEST_PROVIDER'
  | 'EXPORT_PROVIDERS'
  | 'IMPORT_PROVIDERS'

export interface Message {
  type: MessageType
  payload?: unknown
}

export interface MessageResponse<T = unknown> {
  success: boolean
  data?: T
  error?: string
}
```

- [ ] **步骤 2：编写类型测试**

```typescript
import { describe, it, expect } from 'vitest'
import type { Provider, StorageData, ExportData, TestStatus } from '../../src/types'

describe('Type Definitions', () => {
  it('should create a valid Provider object', () => {
    const provider: Provider = {
      id: 'test-id',
      name: 'Test Provider',
      baseUrl: 'https://api.test.com',
      apiKey: 'test-key',
      isActive: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    expect(provider.id).toBe('test-id')
    expect(provider.isActive).toBe(true)
  })

  it('should create a valid Provider with TestStatus', () => {
    const testStatus: TestStatus = {
      lastTestTime: Date.now(),
      isSuccess: true,
    }
    const provider: Provider = {
      id: 'test-id',
      name: 'Test Provider',
      baseUrl: 'https://api.test.com',
      apiKey: 'test-key',
      isActive: true,
      testStatus,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    expect(provider.testStatus?.isSuccess).toBe(true)
  })

  it('should create a valid StorageData object', () => {
    const storageData: StorageData = {
      providers: [],
      activeProviderId: null,
    }
    expect(storageData.providers).toEqual([])
    expect(storageData.activeProviderId).toBeNull()
  })

  it('should create a valid ExportData object', () => {
    const exportData: ExportData = {
      version: '1.0',
      exportedAt: new Date().toISOString(),
      providers: [
        {
          name: 'Test',
          baseUrl: 'https://api.test.com',
          apiKey: 'test-key',
        },
      ],
    }
    expect(exportData.version).toBe('1.0')
    expect(exportData.providers).toHaveLength(1)
  })
})
```

- [ ] **步骤 3：运行测试验证通过**

运行：`npm test tests/types/index.test.ts`

预期：PASS

- [ ] **步骤 4：Commit**

```bash
git add src/types/index.ts tests/types/index.test.ts
git commit -m "feat: add TypeScript type definitions"
```

---

### 任务 4：实现 UUID 工具

**文件：**
- 创建：`src/utils/uuid.ts`
- 测试：`tests/utils/uuid.test.ts`

- [ ] **步骤 1：编写失败的测试**

```typescript
import { describe, it, expect } from 'vitest'
import { generateUUID } from '../../src/utils/uuid'

describe('UUID Utility', () => {
  it('should generate a valid UUID v4', () => {
    const uuid = generateUUID()
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    expect(uuid).toMatch(uuidRegex)
  })

  it('should generate unique UUIDs', () => {
    const uuids = new Set<string>()
    for (let i = 0; i < 100; i++) {
      uuids.add(generateUUID())
    }
    expect(uuids.size).toBe(100)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test tests/utils/uuid.test.ts`

预期：FAIL，报错 "Cannot find module"

- [ ] **步骤 3：实现 UUID 生成函数**

```typescript
export function generateUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npm test tests/utils/uuid.test.ts`

预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add src/utils/uuid.ts tests/utils/uuid.test.ts
git commit -m "feat: add UUID generation utility"
```

---

### 任务 5：实现存储工具

**文件：**
- 创建：`src/utils/storage.ts`
- 测试：`tests/utils/storage.test.ts`

- [ ] **步骤 1：编写失败的测试**

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  getProviders,
  addProvider,
  updateProvider,
  deleteProvider,
  setActiveProvider,
  getActiveProvider,
} from '../../src/utils/storage'
import type { Provider, StorageData } from '../../src/types'

const mockStorage: { [key: string]: unknown } = {}

global.chrome = {
  storage: {
    local: {
      get: vi.fn((keys: string[]) => {
        const result: { [key: string]: unknown } = {}
        keys.forEach(key => {
          if (mockStorage[key] !== undefined) {
            result[key] = mockStorage[key]
          }
        })
        return Promise.resolve(result)
      }),
      set: vi.fn((items: { [key: string]: unknown }) => {
        Object.assign(mockStorage, items)
        return Promise.resolve()
      }),
    },
  },
} as unknown as typeof chrome

describe('Storage Utility', () => {
  beforeEach(() => {
    Object.keys(mockStorage).forEach(key => delete mockStorage[key])
  })

  it('should return empty providers list initially', async () => {
    const providers = await getProviders()
    expect(providers).toEqual([])
  })

  it('should add a provider', async () => {
    const provider: Omit<Provider, 'id' | 'createdAt' | 'updatedAt'> = {
      name: 'Test Provider',
      baseUrl: 'https://api.test.com',
      apiKey: 'test-key',
      isActive: false,
    }
    const result = await addProvider(provider)
    expect(result.name).toBe('Test Provider')
    expect(result.id).toBeDefined()
    expect(result.createdAt).toBeDefined()
    expect(result.updatedAt).toBeDefined()
  })

  it('should update a provider', async () => {
    const provider = await addProvider({
      name: 'Test',
      baseUrl: 'https://api.test.com',
      apiKey: 'test-key',
      isActive: false,
    })
    const updated = await updateProvider(provider.id, { name: 'Updated' })
    expect(updated?.name).toBe('Updated')
    expect(updated?.updatedAt).toBeGreaterThan(provider.updatedAt)
  })

  it('should delete a provider', async () => {
    const provider = await addProvider({
      name: 'Test',
      baseUrl: 'https://api.test.com',
      apiKey: 'test-key',
      isActive: false,
    })
    await deleteProvider(provider.id)
    const providers = await getProviders()
    expect(providers).toHaveLength(0)
  })

  it('should set active provider', async () => {
    const provider1 = await addProvider({
      name: 'Provider 1',
      baseUrl: 'https://api.test.com',
      apiKey: 'test-key',
      isActive: false,
    })
    const provider2 = await addProvider({
      name: 'Provider 2',
      baseUrl: 'https://api.test.com',
      apiKey: 'test-key',
      isActive: false,
    })
    await setActiveProvider(provider1.id)
    const active = await getActiveProvider()
    expect(active?.id).toBe(provider1.id)
    
    await setActiveProvider(provider2.id)
    const newActive = await getActiveProvider()
    expect(newActive?.id).toBe(provider2.id)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test tests/utils/storage.test.ts`

预期：FAIL，报错 "Cannot find module"

- [ ] **步骤 3：实现存储工具函数**

```typescript
import type { Provider, StorageData } from '../types'
import { generateUUID } from './uuid'

const STORAGE_KEY = 'codex_switch_data'

async function getStorageData(): Promise<StorageData> {
  const result = await chrome.storage.local.get(STORAGE_KEY)
  return result[STORAGE_KEY] || { providers: [], activeProviderId: null }
}

async function setStorageData(data: StorageData): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: data })
}

export async function getProviders(): Promise<Provider[]> {
  const data = await getStorageData()
  return data.providers
}

export async function addProvider(
  provider: Omit<Provider, 'id' | 'createdAt' | 'updatedAt'>
): Promise<Provider> {
  const data = await getStorageData()
  const now = Date.now()
  const newProvider: Provider = {
    ...provider,
    id: generateUUID(),
    createdAt: now,
    updatedAt: now,
  }
  data.providers.push(newProvider)
  await setStorageData(data)
  return newProvider
}

export async function updateProvider(
  id: string,
  updates: Partial<Omit<Provider, 'id' | 'createdAt'>>
): Promise<Provider | null> {
  const data = await getStorageData()
  const index = data.providers.findIndex(p => p.id === id)
  if (index === -1) return null
  
  data.providers[index] = {
    ...data.providers[index],
    ...updates,
    updatedAt: Date.now(),
  }
  await setStorageData(data)
  return data.providers[index]
}

export async function deleteProvider(id: string): Promise<void> {
  const data = await getStorageData()
  data.providers = data.providers.filter(p => p.id !== id)
  if (data.activeProviderId === id) {
    data.activeProviderId = null
  }
  await setStorageData(data)
}

export async function setActiveProvider(id: string): Promise<void> {
  const data = await getStorageData()
  data.providers = data.providers.map(p => ({
    ...p,
    isActive: p.id === id,
  }))
  data.activeProviderId = id
  await setStorageData(data)
}

export async function getActiveProvider(): Promise<Provider | null> {
  const data = await getStorageData()
  if (!data.activeProviderId) return null
  return data.providers.find(p => p.id === data.activeProviderId) || null
}

export async function clearAllProviders(): Promise<void> {
  await setStorageData({ providers: [], activeProviderId: null })
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npm test tests/utils/storage.test.ts`

预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add src/utils/storage.ts tests/utils/storage.test.ts
git commit -m "feat: add storage utility functions"
```

---

### 任务 6：实现 API 测试工具

**文件：**
- 创建：`src/utils/api.ts`
- 测试：`tests/utils/api.test.ts`

- [ ] **步骤 1：编写失败的测试**

```typescript
import { describe, it, expect, vi } from 'vitest'
import { testProviderConnection } from '../../src/utils/api'
import type { TestResult } from '../../src/types'

global.fetch = vi.fn()

describe('API Utility', () => {
  it('should return success for valid API response', async () => {
    (fetch as any).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: 'Hello!' } }] }),
    })
    
    const result = await testProviderConnection(
      'https://api.test.com',
      'test-key'
    )
    expect(result.success).toBe(true)
    expect(result.message).toContain('Connection successful')
  })

  it('should return error for 401 response', async () => {
    (fetch as any).mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
    })
    
    const result = await testProviderConnection(
      'https://api.test.com',
      'invalid-key'
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('Invalid API Key')
  })

  it('should return error for network failure', async () => {
    (fetch as any).mockRejectedValueOnce(new Error('Network error'))
    
    const result = await testProviderConnection(
      'https://api.test.com',
      'test-key'
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('Connection failed')
  })

  it('should return error for timeout', async () => {
    (fetch as any).mockImplementationOnce(() => 
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Timeout')), 100)
      )
    )
    
    const result = await testProviderConnection(
      'https://api.test.com',
      'test-key'
    )
    expect(result.success).toBe(false)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test tests/utils/api.test.ts`

预期：FAIL，报错 "Cannot find module"

- [ ] **步骤 3：实现 API 测试函数**

```typescript
import type { TestResult } from '../types'

export async function testProviderConnection(
  baseUrl: string,
  apiKey: string
): Promise<TestResult> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 10000)

  try {
    const url = baseUrl.endsWith('/')
      ? `${baseUrl}v1/chat/completions`
      : `${baseUrl}/v1/chat/completions`

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-3.5-turbo',
        messages: [{ role: 'user', content: 'Hi' }],
        max_tokens: 10,
      }),
      signal: controller.signal,
    })

    clearTimeout(timeoutId)

    if (!response.ok) {
      return handleError(response.status, response.statusText)
    }

    const data = await response.json()
    return {
      success: true,
      message: `Connection successful. Response: ${data.choices?.[0]?.message?.content || 'OK'}`,
    }
  } catch (error) {
    clearTimeout(timeoutId)
    
    if (error instanceof Error) {
      if (error.name === 'AbortError') {
        return {
          success: false,
          message: 'Request timeout',
          error: 'Request timeout after 10 seconds',
        }
      }
      return {
        success: false,
        message: 'Connection failed',
        error: `Connection failed: ${error.message}`,
      }
    }
    
    return {
      success: false,
      message: 'Unknown error',
      error: 'An unknown error occurred',
    }
  }
}

function handleError(status: number, statusText: string): TestResult {
  switch (status) {
    case 401:
      return {
        success: false,
        message: 'Authentication failed',
        error: 'Invalid API Key',
      }
    case 403:
      return {
        success: false,
        message: 'Permission denied',
        error: 'Insufficient quota or permission denied',
      }
    case 500:
      return {
        success: false,
        message: 'Server error',
        error: 'Server error occurred',
      }
    default:
      return {
        success: false,
        message: `HTTP ${status}`,
        error: `Request failed with status ${status}: ${statusText}`,
      }
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npm test tests/utils/api.test.ts`

预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add src/utils/api.ts tests/utils/api.test.ts
git commit -m "feat: add API testing utility"
```

---

### 任务 7：实现导入导出工具

**文件：**
- 创建：`src/utils/export.ts`
- 测试：`tests/utils/export.test.ts`

- [ ] **步骤 1：编写失败的测试**

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { exportProviders, importProviders, validateExportData } from '../../src/utils/export'
import type { Provider, ExportData } from '../../src/types'

describe('Export Utility', () => {
  const mockProviders: Provider[] = [
    {
      id: 'test-1',
      name: 'Provider 1',
      baseUrl: 'https://api.test1.com',
      apiKey: 'key1',
      isActive: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
    {
      id: 'test-2',
      name: 'Provider 2',
      baseUrl: 'https://api.test2.com',
      apiKey: 'key2',
      isActive: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
  ]

  it('should export providers to correct format', () => {
    const exported = exportProviders(mockProviders)
    expect(exported.version).toBe('1.0')
    expect(exported.exportedAt).toBeDefined()
    expect(exported.providers).toHaveLength(2)
    expect(exported.providers[0].name).toBe('Provider 1')
    expect(exported.providers[0]).not.toHaveProperty('id')
    expect(exported.providers[0]).not.toHaveProperty('isActive')
  })

  it('should validate correct export data', () => {
    const data: ExportData = {
      version: '1.0',
      exportedAt: new Date().toISOString(),
      providers: [
        {
          name: 'Test',
          baseUrl: 'https://api.test.com',
          apiKey: 'test-key',
        },
      ],
    }
    const result = validateExportData(data)
    expect(result.valid).toBe(true)
  })

  it('should reject invalid export data', () => {
    const data = {
      version: '1.0',
      providers: [
        {
          name: 'Test',
        },
      ],
    }
    const result = validateExportData(data)
    expect(result.valid).toBe(false)
    expect(result.errors).toBeDefined()
  })

  it('should import providers correctly', () => {
    const data: ExportData = {
      version: '1.0',
      exportedAt: new Date().toISOString(),
      providers: [
        {
          name: 'Imported Provider',
          baseUrl: 'https://api.imported.com',
          apiKey: 'imported-key',
        },
      ],
    }
    const imported = importProviders(data)
    expect(imported).toHaveLength(1)
    expect(imported[0].name).toBe('Imported Provider')
    expect(imported[0].id).toBeDefined()
    expect(imported[0].isActive).toBe(false)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test tests/utils/export.test.ts`

预期：FAIL，报错 "Cannot find module"

- [ ] **步骤 3：实现导入导出函数**

```typescript
import type { Provider, ExportData } from '../types'
import { generateUUID } from './uuid'

export function exportProviders(providers: Provider[]): ExportData {
  return {
    version: '1.0',
    exportedAt: new Date().toISOString(),
    providers: providers.map(p => ({
      name: p.name,
      baseUrl: p.baseUrl,
      apiKey: p.apiKey,
    })),
  }
}

export function validateExportData(data: unknown): {
  valid: boolean
  errors?: string[]
} {
  if (!data || typeof data !== 'object') {
    return { valid: false, errors: ['Data must be an object'] }
  }

  const obj = data as Record<string, unknown>

  if (obj.version !== '1.0') {
    return { valid: false, errors: ['Invalid or missing version'] }
  }

  if (!Array.isArray(obj.providers)) {
    return { valid: false, errors: ['Providers must be an array'] }
  }

  const errors: string[] = []
  obj.providers.forEach((provider, index) => {
    if (!provider || typeof provider !== 'object') {
      errors.push(`Provider ${index} must be an object`)
      return
    }
    if (!provider.name || typeof provider.name !== 'string') {
      errors.push(`Provider ${index} missing name`)
    }
    if (!provider.baseUrl || typeof provider.baseUrl !== 'string') {
      errors.push(`Provider ${index} missing baseUrl`)
    }
    if (!provider.apiKey || typeof provider.apiKey !== 'string') {
      errors.push(`Provider ${index} missing apiKey`)
    }
  })

  if (errors.length > 0) {
    return { valid: false, errors }
  }

  return { valid: true }
}

export function importProviders(data: ExportData): Array<Omit<Provider, 'id' | 'createdAt' | 'updatedAt'>> {
  return data.providers.map(p => ({
    name: p.name,
    baseUrl: p.baseUrl,
    apiKey: p.apiKey,
    isActive: false,
  }))
}

export function downloadJSON(data: ExportData, filename: string): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export function readJSONFile(file: File): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = (e) => {
      try {
        const data = JSON.parse(e.target?.result as string)
        resolve(data)
      } catch (error) {
        reject(new Error('Invalid JSON file'))
      }
    }
    reader.onerror = () => reject(new Error('Failed to read file'))
    reader.readAsText(file)
  })
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npm test tests/utils/export.test.ts`

预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add src/utils/export.ts tests/utils/export.test.ts
git commit -m "feat: add import/export utilities"
```

---

## 阶段 2：核心功能

### 任务 8：实现 Background Service Worker

**文件：**
- 创建：`src/background/index.ts`

- [ ] **步骤 1：实现 Background Service Worker**

```typescript
import type { Message, MessageResponse, Provider, TestResult } from '../types'
import {
  getProviders,
  addProvider,
  updateProvider,
  deleteProvider,
  setActiveProvider,
  getActiveProvider,
} from '../utils/storage'
import { testProviderConnection } from '../utils/api'
import { exportProviders, validateExportData, importProviders } from '../utils/export'

chrome.runtime.onMessage.addListener(
  (message: Message, sender, sendResponse) => {
    handleMessage(message).then(sendResponse)
    return true
  }
)

async function handleMessage(message: Message): Promise<MessageResponse> {
  try {
    switch (message.type) {
      case 'GET_PROVIDERS':
        return handleGetProviders()
      
      case 'ADD_PROVIDER':
        return handleAddProvider(message.payload as Omit<Provider, 'id' | 'createdAt' | 'updatedAt'>)
      
      case 'UPDATE_PROVIDER':
        return handleUpdateProvider(message.payload as { id: string; updates: Partial<Provider> })
      
      case 'DELETE_PROVIDER':
        return handleDeleteProvider(message.payload as string)
      
      case 'SET_ACTIVE_PROVIDER':
        return handleSetActiveProvider(message.payload as string)
      
      case 'TEST_PROVIDER':
        return handleTestProvider(message.payload as Provider)
      
      case 'EXPORT_PROVIDERS':
        return handleExportProviders()
      
      case 'IMPORT_PROVIDERS':
        return handleImportProviders(message.payload as unknown)
      
      default:
        return { success: false, error: 'Unknown message type' }
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }
  }
}

async function handleGetProviders(): Promise<MessageResponse<Provider[]>> {
  const providers = await getProviders()
  return { success: true, data: providers }
}

async function handleAddProvider(
  provider: Omit<Provider, 'id' | 'createdAt' | 'updatedAt'>
): Promise<MessageResponse<Provider>> {
  const newProvider = await addProvider(provider)
  return { success: true, data: newProvider }
}

async function handleUpdateProvider(payload: {
  id: string
  updates: Partial<Provider>
}): Promise<MessageResponse<Provider>> {
  const updated = await updateProvider(payload.id, payload.updates)
  if (!updated) {
    return { success: false, error: 'Provider not found' }
  }
  return { success: true, data: updated }
}

async function handleDeleteProvider(id: string): Promise<MessageResponse> {
  await deleteProvider(id)
  return { success: true }
}

async function handleSetActiveProvider(id: string): Promise<MessageResponse> {
  await setActiveProvider(id)
  return { success: true }
}

async function handleTestProvider(provider: Provider): Promise<MessageResponse<TestResult>> {
  const result = await testProviderConnection(provider.baseUrl, provider.apiKey)
  
  await updateProvider(provider.id, {
    testStatus: {
      lastTestTime: Date.now(),
      isSuccess: result.success,
      errorMessage: result.error,
    },
  })
  
  return { success: true, data: result }
}

async function handleExportProviders(): Promise<MessageResponse> {
  const providers = await getProviders()
  const data = exportProviders(providers)
  return { success: true, data }
}

async function handleImportProviders(data: unknown): Promise<MessageResponse> {
  const validation = validateExportData(data)
  if (!validation.valid) {
    return { success: false, error: validation.errors?.join(', ') }
  }
  
  const providers = importProviders(data as Parameters<typeof importProviders>[0])
  for (const provider of providers) {
    await addProvider(provider)
  }
  
  return { success: true }
}
```

- [ ] **步骤 2：Commit**

```bash
git add src/background/index.ts
git commit -m "feat: implement background service worker"
```

---

## 阶段 3：UI 开发

### 任务 9：创建 Chrome 扩展配置文件

**文件：**
- 创建：`public/manifest.json`
- 创建：`public/popup.html`
- 创建：`public/options.html`
- 创建：`public/icon.png`（占位图标）

- [ ] **步骤 1：创建 manifest.json**

```json
{
  "manifest_version": 3,
  "name": "CodexSwitch",
  "version": "1.0.0",
  "description": "OpenAI API Provider Manager",
  "permissions": ["storage"],
  "background": {
    "service_worker": "background.js",
    "type": "module"
  },
  "action": {
    "default_popup": "popup.html",
    "default_icon": {
      "16": "icon.png",
      "48": "icon.png",
      "128": "icon.png"
    }
  },
  "options_page": "options.html",
  "icons": {
    "16": "icon.png",
    "48": "icon.png",
    "128": "icon.png"
  }
}
```

- [ ] **步骤 2：创建 popup.html**

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CodexSwitch</title>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="../src/popup/index.tsx"></script>
</body>
</html>
```

- [ ] **步骤 3：创建 options.html**

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CodexSwitch - 供应商管理</title>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="../src/options/index.tsx"></script>
</body>
</html>
```

- [ ] **步骤 4：创建占位图标**

创建一个简单的 128x128 PNG 图标文件（可以使用在线工具生成或暂时使用占位图）

- [ ] **步骤 5：Commit**

```bash
git add public/manifest.json public/popup.html public/options.html public/icon.png
git commit -m "feat: add Chrome extension manifest and HTML files"
```

---

### 任务 10：实现共享组件 - StatusBadge

**文件：**
- 创建：`src/components/StatusBadge.tsx`
- 测试：`tests/components/StatusBadge.test.tsx`

- [ ] **步骤 1：编写失败的测试**

```typescript
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { StatusBadge } from '../../src/components/StatusBadge'
import type { TestStatus } from '../../src/types'

describe('StatusBadge Component', () => {
  it('should render success badge', () => {
    const status: TestStatus = {
      lastTestTime: Date.now(),
      isSuccess: true,
    }
    render(<StatusBadge status={status} />)
    expect(screen.getByText(/已验证/)).toBeDefined()
  })

  it('should render failure badge', () => {
    const status: TestStatus = {
      lastTestTime: Date.now(),
      isSuccess: false,
      errorMessage: 'Connection failed',
    }
    render(<StatusBadge status={status} />)
    expect(screen.getByText(/失败/)).toBeDefined()
  })

  it('should render untested badge when status is undefined', () => {
    render(<StatusBadge />)
    expect(screen.getByText(/未测试/)).toBeDefined()
  })

  it('should display relative time', () => {
    const oneHourAgo = Date.now() - 3600000
    const status: TestStatus = {
      lastTestTime: oneHourAgo,
      isSuccess: true,
    }
    render(<StatusBadge status={status} />)
    expect(screen.getByText(/1小时前/)).toBeDefined()
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test tests/components/StatusBadge.test.tsx`

预期：FAIL，报错 "Cannot find module"

- [ ] **步骤 3：实现 StatusBadge 组件**

```typescript
import React from 'react'
import type { TestStatus } from '../types'

interface StatusBadgeProps {
  status?: TestStatus
}

function formatRelativeTime(timestamp: number): string {
  const now = Date.now()
  const diff = now - timestamp
  const minutes = Math.floor(diff / 60000)
  const hours = Math.floor(diff / 3600000)
  const days = Math.floor(diff / 86400000)

  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes}分钟前`
  if (hours < 24) return `${hours}小时前`
  return `${days}天前`
}

export function StatusBadge({ status }: StatusBadgeProps) {
  if (!status) {
    return (
      <span className="inline-flex items-center px-2 py-1 rounded text-xs bg-gray-100 text-gray-600">
        未测试
      </span>
    )
  }

  if (status.isSuccess) {
    return (
      <span className="inline-flex items-center px-2 py-1 rounded text-xs bg-green-100 text-green-700">
        ✓ 已验证 ({formatRelativeTime(status.lastTestTime)})
      </span>
    )
  }

  return (
    <span className="inline-flex items-center px-2 py-1 rounded text-xs bg-red-100 text-red-700">
      ✗ 失败 ({status.errorMessage || '未知错误'})
    </span>
  )
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npm test tests/components/StatusBadge.test.tsx`

预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add src/components/StatusBadge.tsx tests/components/StatusBadge.test.tsx
git commit -m "feat: add StatusBadge component"
```

---

### 任务 11：实现共享组件 - ProviderCard

**文件：**
- 创建：`src/components/ProviderCard.tsx`
- 测试：`tests/components/ProviderCard.test.tsx`

- [ ] **步骤 1：编写失败的测试**

```typescript
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ProviderCard } from '../../src/components/ProviderCard'
import type { Provider } from '../../src/types'

describe('ProviderCard Component', () => {
  const mockProvider: Provider = {
    id: 'test-1',
    name: 'Test Provider',
    baseUrl: 'https://api.test.com',
    apiKey: 'test-key',
    isActive: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }

  it('should render provider information', () => {
    render(
      <ProviderCard
        provider={mockProvider}
        onTest={() => {}}
        onEdit={() => {}}
        onDelete={() => {}}
      />
    )
    expect(screen.getByText('Test Provider')).toBeDefined()
    expect(screen.getByText('https://api.test.com')).toBeDefined()
  })

  it('should call onTest when test button clicked', () => {
    const onTest = vi.fn()
    render(
      <ProviderCard
        provider={mockProvider}
        onTest={onTest}
        onEdit={() => {}}
        onDelete={() => {}}
      />
    )
    fireEvent.click(screen.getByText('测试'))
    expect(onTest).toHaveBeenCalledWith(mockProvider.id)
  })

  it('should call onEdit when edit button clicked', () => {
    const onEdit = vi.fn()
    render(
      <ProviderCard
        provider={mockProvider}
        onTest={() => {}}
        onEdit={onEdit}
        onDelete={() => {}}
      />
    )
    fireEvent.click(screen.getByText('编辑'))
    expect(onEdit).toHaveBeenCalledWith(mockProvider.id)
  })

  it('should call onDelete when delete button clicked', () => {
    const onDelete = vi.fn()
    render(
      <ProviderCard
        provider={mockProvider}
        onTest={() => {}}
        onEdit={() => {}}
        onDelete={onDelete}
      />
    )
    fireEvent.click(screen.getByText('删除'))
    expect(onDelete).toHaveBeenCalledWith(mockProvider.id)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test tests/components/ProviderCard.test.tsx`

预期：FAIL，报错 "Cannot find module"

- [ ] **步骤 3：实现 ProviderCard 组件**

```typescript
import React from 'react'
import type { Provider } from '../types'
import { StatusBadge } from './StatusBadge'

interface ProviderCardProps {
  provider: Provider
  onTest: (id: string) => void
  onEdit: (id: string) => void
  onDelete: (id: string) => void
  showActions?: boolean
}

export function ProviderCard({
  provider,
  onTest,
  onEdit,
  onDelete,
  showActions = true,
}: ProviderCardProps) {
  return (
    <div className="border rounded-lg p-4 mb-3 bg-white shadow-sm">
      <div className="flex justify-between items-start mb-2">
        <div>
          <h3 className="font-semibold text-lg">{provider.name}</h3>
          <p className="text-sm text-gray-600">{provider.baseUrl}</p>
        </div>
        <StatusBadge status={provider.testStatus} />
      </div>
      
      {showActions && (
        <div className="flex gap-2 mt-3">
          <button
            onClick={() => onTest(provider.id)}
            className="px-3 py-1 text-sm bg-blue-500 text-white rounded hover:bg-blue-600"
          >
            测试
          </button>
          <button
            onClick={() => onEdit(provider.id)}
            className="px-3 py-1 text-sm bg-gray-500 text-white rounded hover:bg-gray-600"
          >
            编辑
          </button>
          <button
            onClick={() => onDelete(provider.id)}
            className="px-3 py-1 text-sm bg-red-500 text-white rounded hover:bg-red-600"
          >
            删除
          </button>
        </div>
      )}
    </div>
  )
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npm test tests/components/ProviderCard.test.tsx`

预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add src/components/ProviderCard.tsx tests/components/ProviderCard.test.tsx
git commit -m "feat: add ProviderCard component"
```

---

### 任务 12：实现共享组件 - ProviderForm

**文件：**
- 创建：`src/components/ProviderForm.tsx`
- 测试：`tests/components/ProviderForm.test.tsx`

- [ ] **步骤 1：编写失败的测试**

```typescript
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ProviderForm } from '../../src/components/ProviderForm'
import type { Provider } from '../../src/types'

describe('ProviderForm Component', () => {
  it('should render form fields', () => {
    render(<ProviderForm onSave={() => {}} onCancel={() => {}} />)
    expect(screen.getByLabelText(/供应商名称/)).toBeDefined()
    expect(screen.getByLabelText(/Base URL/)).toBeDefined()
    expect(screen.getByLabelText(/API Key/)).toBeDefined()
  })

  it('should call onSave with form data', () => {
    const onSave = vi.fn()
    render(<ProviderForm onSave={onSave} onCancel={() => {}} />)
    
    fireEvent.change(screen.getByLabelText(/供应商名称/), {
      target: { value: 'Test Provider' },
    })
    fireEvent.change(screen.getByLabelText(/Base URL/), {
      target: { value: 'https://api.test.com' },
    })
    fireEvent.change(screen.getByLabelText(/API Key/), {
      target: { value: 'test-key' },
    })
    
    fireEvent.click(screen.getByText('保存并测试'))
    
    expect(onSave).toHaveBeenCalledWith({
      name: 'Test Provider',
      baseUrl: 'https://api.test.com',
      apiKey: 'test-key',
      isActive: false,
    })
  })

  it('should populate form when editing', () => {
    const provider: Provider = {
      id: 'test-1',
      name: 'Existing Provider',
      baseUrl: 'https://api.existing.com',
      apiKey: 'existing-key',
      isActive: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    render(<ProviderForm provider={provider} onSave={() => {}} onCancel={() => {}} />)
    
    expect(screen.getByLabelText(/供应商名称/)).toHaveValue('Existing Provider')
    expect(screen.getByLabelText(/Base URL/)).toHaveValue('https://api.existing.com')
    expect(screen.getByLabelText(/API Key/)).toHaveValue('existing-key')
  })

  it('should call onCancel when cancel button clicked', () => {
    const onCancel = vi.fn()
    render(<ProviderForm onSave={() => {}} onCancel={onCancel} />)
    
    fireEvent.click(screen.getByText('取消'))
    expect(onCancel).toHaveBeenCalled()
  })

  it('should toggle API key visibility', () => {
    render(<ProviderForm onSave={() => {}} onCancel={() => {}} />)
    
    const apiKeyInput = screen.getByLabelText(/API Key/)
    expect(apiKeyInput).toHaveAttribute('type', 'password')
    
    fireEvent.click(screen.getByText('👁'))
    expect(apiKeyInput).toHaveAttribute('type', 'text')
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test tests/components/ProviderForm.test.tsx`

预期：FAIL，报错 "Cannot find module"

- [ ] **步骤 3：实现 ProviderForm 组件**

```typescript
import React, { useState, useEffect } from 'react'
import type { Provider } from '../types'

interface ProviderFormProps {
  provider?: Provider
  onSave: (data: Omit<Provider, 'id' | 'createdAt' | 'updatedAt'>) => void
  onCancel: () => void
}

export function ProviderForm({ provider, onSave, onCancel }: ProviderFormProps) {
  const [name, setName] = useState(provider?.name || '')
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl || '')
  const [apiKey, setApiKey] = useState(provider?.apiKey || '')
  const [showApiKey, setShowApiKey] = useState(false)

  useEffect(() => {
    if (provider) {
      setName(provider.name)
      setBaseUrl(provider.baseUrl)
      setApiKey(provider.apiKey)
    }
  }, [provider])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    onSave({
      name,
      baseUrl,
      apiKey,
      isActive: provider?.isActive || false,
    })
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="block text-sm font-medium mb-1">
          供应商名称
        </label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full px-3 py-2 border rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
          required
        />
      </div>

      <div>
        <label className="block text-sm font-medium mb-1">
          Base URL
        </label>
        <input
          type="url"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          className="w-full px-3 py-2 border rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
          placeholder="https://api.openai.com"
          required
        />
      </div>

      <div>
        <label className="block text-sm font-medium mb-1">
          API Key
        </label>
        <div className="flex gap-2">
          <input
            type={showApiKey ? 'text' : 'password'}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            className="flex-1 px-3 py-2 border rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
            required
          />
          <button
            type="button"
            onClick={() => setShowApiKey(!showApiKey)}
            className="px-3 py-2 border rounded hover:bg-gray-100"
          >
            👁
          </button>
        </div>
      </div>

      <div className="flex gap-2 justify-end">
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-2 border rounded hover:bg-gray-100"
        >
          取消
        </button>
        <button
          type="submit"
          className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
        >
          保存并测试
        </button>
      </div>
    </form>
  )
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npm test tests/components/ProviderForm.test.tsx`

预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add src/components/ProviderForm.tsx tests/components/ProviderForm.test.tsx
git commit -m "feat: add ProviderForm component"
```

---

### 任务 13：实现 Popup 界面

**文件：**
- 创建：`src/popup/index.tsx`
- 创建：`src/popup/App.tsx`
- 创建：`src/popup/style.css`

- [ ] **步骤 1：创建 Popup 样式文件**

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

body {
  width: 300px;
  min-height: 400px;
  margin: 0;
  padding: 0;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', sans-serif;
}
```

- [ ] **步骤 2：创建 Popup 入口文件**

```typescript
import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import './style.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
```

- [ ] **步骤 3：创建 Popup 主组件**

```typescript
import React, { useState, useEffect } from 'react'
import type { Provider } from '../types'
import { StatusBadge } from '../components/StatusBadge'

function sendMessage<T>(type: string, payload?: unknown): Promise<T> {
  return chrome.runtime.sendMessage({ type, payload })
}

export function App() {
  const [providers, setProviders] = useState<Provider[]>([])
  const [activeProvider, setActiveProvider] = useState<Provider | null>(null)
  const [testing, setTesting] = useState(false)

  useEffect(() => {
    loadProviders()
  }, [])

  async function loadProviders() {
    const response = await sendMessage<{ success: boolean; data: Provider[] }>('GET_PROVIDERS')
    if (response.success) {
      setProviders(response.data)
      const active = response.data.find(p => p.isActive)
      setActiveProvider(active || null)
    }
  }

  async function handleSetActive(id: string) {
    await sendMessage('SET_ACTIVE_PROVIDER', id)
    await loadProviders()
  }

  async function handleTestProvider(id: string) {
    setTesting(true)
    const provider = providers.find(p => p.id === id)
    if (provider) {
      await sendMessage('TEST_PROVIDER', provider)
      await loadProviders()
    }
    setTesting(false)
  }

  function handleOpenOptions() {
    chrome.runtime.openOptionsPage()
  }

  return (
    <div className="p-4">
      <div className="mb-4">
        <h2 className="text-sm font-semibold text-gray-600 mb-1">当前供应商</h2>
        {activeProvider ? (
          <div className="bg-blue-50 rounded p-3">
            <div className="font-semibold">{activeProvider.name}</div>
            <div className="text-sm text-gray-600">{activeProvider.baseUrl}</div>
            <div className="mt-1">
              <StatusBadge status={activeProvider.testStatus} />
            </div>
          </div>
        ) : (
          <div className="text-gray-500 text-sm">未选择供应商</div>
        )}
      </div>

      <div className="mb-4">
        <h2 className="text-sm font-semibold text-gray-600 mb-2">供应商列表</h2>
        <div className="space-y-2 max-h-48 overflow-y-auto">
          {providers.map(provider => (
            <div
              key={provider.id}
              className="flex items-center justify-between p-2 border rounded hover:bg-gray-50"
            >
              <label className="flex items-center flex-1 cursor-pointer">
                <input
                  type="radio"
                  name="activeProvider"
                  checked={provider.isActive}
                  onChange={() => handleSetActive(provider.id)}
                  className="mr-2"
                />
                <div className="flex-1">
                  <div className="font-medium text-sm">{provider.name}</div>
                  <div className="text-xs text-gray-500">{provider.baseUrl}</div>
                </div>
              </label>
              <button
                onClick={() => handleTestProvider(provider.id)}
                disabled={testing}
                className="px-2 py-1 text-xs bg-blue-500 text-white rounded hover:bg-blue-600 disabled:opacity-50"
              >
                测试
              </button>
            </div>
          ))}
        </div>
      </div>

      <div className="flex gap-2">
        <button
          onClick={() => activeProvider && handleTestProvider(activeProvider.id)}
          disabled={!activeProvider || testing}
          className="flex-1 px-3 py-2 bg-green-500 text-white rounded hover:bg-green-600 disabled:opacity-50"
        >
          {testing ? '测试中...' : '快速测试'}
        </button>
        <button
          onClick={handleOpenOptions}
          className="flex-1 px-3 py-2 bg-gray-500 text-white rounded hover:bg-gray-600"
        >
          管理供应商
        </button>
      </div>
    </div>
  )
}
```

- [ ] **步骤 4：Commit**

```bash
git add src/popup/
git commit -m "feat: implement popup interface"
```

---

### 任务 14：实现 Options 页面

**文件：**
- 创建：`src/options/index.tsx`
- 创建：`src/options/App.tsx`
- 创建：`src/options/style.css`

- [ ] **步骤 1：创建 Options 样式文件**

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

body {
  margin: 0;
  padding: 0;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', sans-serif;
  background-color: #f5f5f5;
}
```

- [ ] **步骤 2：创建 Options 入口文件**

```typescript
import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import './style.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
```

- [ ] **步骤 3：创建 Options 主组件**

```typescript
import React, { useState, useEffect } from 'react'
import type { Provider } from '../types'
import { ProviderCard } from '../components/ProviderCard'
import { ProviderForm } from '../components/ProviderForm'
import { exportProviders, downloadJSON, readJSONFile, validateExportData } from '../utils/export'

function sendMessage<T>(type: string, payload?: unknown): Promise<T> {
  return chrome.runtime.sendMessage({ type, payload })
}

export function App() {
  const [providers, setProviders] = useState<Provider[]>([])
  const [showForm, setShowForm] = useState(false)
  const [editingProvider, setEditingProvider] = useState<Provider | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    loadProviders()
  }, [])

  async function loadProviders() {
    const response = await sendMessage<{ success: boolean; data: Provider[] }>('GET_PROVIDERS')
    if (response.success) {
      setProviders(response.data)
    }
  }

  async function handleSave(data: Omit<Provider, 'id' | 'createdAt' | 'updatedAt'>) {
    setLoading(true)
    
    if (editingProvider) {
      await sendMessage('UPDATE_PROVIDER', {
        id: editingProvider.id,
        updates: data,
      })
      await sendMessage('TEST_PROVIDER', { ...editingProvider, ...data })
    } else {
      const response = await sendMessage<{ success: boolean; data: Provider }>(
        'ADD_PROVIDER',
        data
      )
      if (response.success) {
        await sendMessage('TEST_PROVIDER', response.data)
      }
    }
    
    setShowForm(false)
    setEditingProvider(null)
    await loadProviders()
    setLoading(false)
  }

  async function handleTest(id: string) {
    const provider = providers.find(p => p.id === id)
    if (provider) {
      await sendMessage('TEST_PROVIDER', provider)
      await loadProviders()
    }
  }

  async function handleEdit(id: string) {
    const provider = providers.find(p => p.id === id)
    if (provider) {
      setEditingProvider(provider)
      setShowForm(true)
    }
  }

  async function handleDelete(id: string) {
    if (confirm('确定要删除这个供应商吗？')) {
      await sendMessage('DELETE_PROVIDER', id)
      await loadProviders()
    }
  }

  async function handleExport() {
    const response = await sendMessage<{ success: boolean; data: unknown }>('EXPORT_PROVIDERS')
    if (response.success && response.data) {
      downloadJSON(
        response.data as Parameters<typeof downloadJSON>[0],
        `codex-switch-${new Date().toISOString().split('T')[0]}.json`
      )
    }
  }

  async function handleImport(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) return

    try {
      const data = await readJSONFile(file)
      const validation = validateExportData(data)
      
      if (!validation.valid) {
        alert(`导入失败：${validation.errors?.join(', ')}`)
        return
      }

      const response = await sendMessage('IMPORT_PROVIDERS', data)
      if (response.success) {
        alert('导入成功')
        await loadProviders()
      } else {
        alert(`导入失败：${response.error}`)
      }
    } catch (error) {
      alert(`导入失败：${error instanceof Error ? error.message : '未知错误'}`)
    }
    
    event.target.value = ''
  }

  function handleCancel() {
    setShowForm(false)
    setEditingProvider(null)
  }

  return (
    <div className="max-w-4xl mx-auto p-6">
      <h1 className="text-2xl font-bold mb-6">供应商管理</h1>

      <div className="mb-6 flex gap-3">
        <button
          onClick={() => setShowForm(true)}
          className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
        >
          + 添加供应商
        </button>
        <label className="px-4 py-2 bg-gray-500 text-white rounded hover:bg-gray-600 cursor-pointer">
          导入
          <input
            type="file"
            accept=".json"
            onChange={handleImport}
            className="hidden"
          />
        </label>
        <button
          onClick={handleExport}
          disabled={providers.length === 0}
          className="px-4 py-2 bg-gray-500 text-white rounded hover:bg-gray-600 disabled:opacity-50"
        >
          导出
        </button>
      </div>

      {showForm && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 w-full max-w-md">
            <h2 className="text-xl font-semibold mb-4">
              {editingProvider ? '编辑供应商' : '添加供应商'}
            </h2>
            <ProviderForm
              provider={editingProvider || undefined}
              onSave={handleSave}
              onCancel={handleCancel}
            />
          </div>
        </div>
      )}

      <div>
        {providers.length === 0 ? (
          <div className="text-center text-gray-500 py-12">
            暂无供应商，点击"添加供应商"开始
          </div>
        ) : (
          providers.map(provider => (
            <ProviderCard
              key={provider.id}
              provider={provider}
              onTest={handleTest}
              onEdit={handleEdit}
              onDelete={handleDelete}
            />
          ))
        )}
      </div>
    </div>
  )
}
```

- [ ] **步骤 4：Commit**

```bash
git add src/options/
git commit -m "feat: implement options page"
```

---

## 阶段 4：构建与测试

### 任务 15：构建扩展

**文件：**
- 修改：`vite.config.ts`

- [ ] **步骤 1：更新 Vite 配置**

```typescript
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: {
        popup: resolve(__dirname, 'public/popup.html'),
        options: resolve(__dirname, 'public/options.html'),
        background: resolve(__dirname, 'src/background/index.ts'),
      },
      output: {
        entryFileNames: (chunkInfo) => {
          if (chunkInfo.name === 'background') {
            return 'background.js'
          }
          return 'assets/[name]-[hash].js'
        },
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash].[ext]',
      },
    },
  },
})
```

- [ ] **步骤 2：构建项目**

运行：`npm run build`

预期：成功构建，生成 dist 目录

- [ ] **步骤 3：复制 manifest 和静态文件**

创建构建后处理脚本或手动复制：
- `public/manifest.json` → `dist/manifest.json`
- `public/icon.png` → `dist/icon.png`

- [ ] **步骤 4：测试加载扩展**

在 Chrome 中：
1. 打开 `chrome://extensions/`
2. 启用"开发者模式"
3. 点击"加载已解压的扩展程序"
4. 选择 `dist` 目录

预期：扩展成功加载，图标显示在工具栏

- [ ] **步骤 5：Commit**

```bash
git add vite.config.ts
git commit -m "chore: update build configuration"
```

---

### 任务 16：功能测试

**测试清单：**

- [ ] **测试 1：添加供应商**
  1. 点击扩展图标打开 Popup
  2. 点击"管理供应商"打开 Options 页面
  3. 点击"添加供应商"
  4. 填写名称、Base URL、API Key
  5. 点击"保存并测试"
  6. 验证供应商出现在列表中
  7. 验证测试状态显示正确

- [ ] **测试 2：切换供应商**
  1. 添加多个供应商
  2. 在 Popup 中点击单选按钮切换
  3. 验证"当前供应商"显示正确
  4. 验证 Options 页面中激活状态正确

- [ ] **测试 3：测试连接**
  1. 点击供应商卡片的"测试"按钮
  2. 验证测试状态更新
  3. 使用无效 API Key 测试
  4. 验证错误信息显示正确

- [ ] **测试 4：编辑供应商**
  1. 点击供应商卡片的"编辑"按钮
  2. 修改名称或 URL
  3. 点击"保存并测试"
  4. 验证更新成功

- [ ] **测试 5：删除供应商**
  1. 点击供应商卡片的"删除"按钮
  2. 确认删除对话框
  3. 验证供应商从列表中移除

- [ ] **测试 6：导入导出**
  1. 点击"导出"按钮
  2. 验证 JSON 文件下载成功
  3. 删除所有供应商
  4. 点击"导入"选择导出的文件
  5. 验证供应商恢复成功

- [ ] **测试 7：快速测试**
  1. 在 Popup 中选择一个供应商
  2. 点击"快速测试"按钮
  3. 验证测试状态更新

- [ ] **步骤：记录测试结果**

创建测试报告文档，记录所有测试的结果和发现的问题。

- [ ] **步骤：修复发现的问题**

根据测试结果修复发现的 bug。

---

## 阶段 5：优化与发布

### 任务 17：优化用户体验

**优化项：**

- [ ] **步骤 1：添加加载状态**
  - 测试时显示加载动画
  - 保存时禁用按钮防止重复提交

- [ ] **步骤 2：优化错误提示**
  - 使用更友好的错误消息
  - 添加错误恢复建议

- [ ] **步骤 3：改进 UI 响应**
  - 添加过渡动画
  - 优化列表滚动性能

- [ ] **步骤 4：添加空状态提示**
  - 无供应商时显示引导信息
  - 无激活供应商时显示提示

- [ ] **步骤 5：Commit**

```bash
git add .
git commit -m "feat: improve user experience"
```

---

### 任务 18：准备发布

**文件：**
- 创建：`README.md`
- 更新：`public/manifest.json`

- [ ] **步骤 1：创建 README.md**

```markdown
# CodexSwitch

OpenAI API 供应商管理 Chrome 浏览器插件。

## 功能特性

- 管理多个 OpenAI 兼容 API 供应商
- 快速切换激活供应商
- 测试 API 连接状态
- 导入/导出供应商配置

## 安装

### 开发模式

1. 克隆仓库
2. 安装依赖：`npm install`
3. 构建：`npm run build`
4. 在 Chrome 中加载 `dist` 目录

### 生产模式

从 Chrome Web Store 安装（待发布）

## 使用说明

### 添加供应商

1. 点击扩展图标
2. 点击"管理供应商"
3. 点击"添加供应商"
4. 填写供应商信息并保存

### 测试连接

- 在供应商列表中点击"测试"按钮
- 或在 Popup 中点击"快速测试"

### 导入导出

- 点击"导出"下载配置文件
- 点击"导入"选择配置文件

## 开发

```bash
# 安装依赖
npm install

# 运行测试
npm test

# 构建
npm run build

# 开发模式
npm run dev
```

## 许可证

MIT
```

- [ ] **步骤 2：更新 manifest.json 版本**

```json
{
  "manifest_version": 3,
  "name": "CodexSwitch",
  "version": "1.0.0",
  "description": "OpenAI API Provider Manager - 管理多个 OpenAI 兼容 API 供应商",
  ...
}
```

- [ ] **步骤 3：创建发布包**

运行：`npm run build`

将 `dist` 目录打包为 zip 文件用于发布。

- [ ] **步骤 4：Commit**

```bash
git add README.md public/manifest.json
git commit -m "docs: add README and prepare for release"
```

---

## 完成检查

- [ ] 所有测试通过
- [ ] 构建成功
- [ ] 功能测试通过
- [ ] 无控制台错误
- [ ] 代码已提交
- [ ] 文档完整

---

## 执行说明

此计划应使用 `superpowers:subagent-driven-development` 或 `superpowers:executing-plans` 技能执行。每个任务应独立完成，包含完整的测试、实现和提交步骤。
