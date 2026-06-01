# haibao-generator

高中销转海报生成控制台，用于选择业务场景、视觉风格、布局结构和模型配置，生成适配有道领世销售场景的海报 prompt，并通过图像模型 API 生成海报。

## 本地运行

```powershell
cd "D:\销售转化策略\海报批量优化\github-haibao-generator"
node local-proxy-server.js
```

打开：

```text
http://127.0.0.1:8787/
```

也可以直接双击 `poster-generator.html`，但仍需要保持 `local-proxy-server.js` 运行，因为本地文件会把生成请求转发到：

```text
http://127.0.0.1:8787/api/generate-poster
```

## Netlify 部署

Netlify 构建配置在 `netlify.toml`：

```toml
[build]
  command = "node scripts/build-netlify.js"
  publish = "dist"

[functions]
  directory = "netlify/functions"
```

部署后，前端请求：

```text
/api/generate-poster
```

会自动由 Netlify Function 处理。

## API Key

不要提交 `.env`。本地使用可复制 `.env.example` 为 `.env` 后填写：

```text
DOUBAO_API_KEY=your-doubao-or-ark-key
DOUBAO_IMAGE_MODEL=doubao-seedream-5-0-260128
DOUBAO_IMAGE_ENDPOINT=https://ark.cn-beijing.volces.com/api/v3/images/generations
OPENAI_API_KEY=your-openai-key
PORT=8787
```

Netlify 线上环境可以在 Project configuration -> Environment variables 中配置同名变量，也可以在页面弹窗里填写个人 API Key。

## 敏感信息原则

时间、价格、名额、满班率、行动暗号、老师姓名、课程名称等销售敏感信息必须由使用者明确输入。未输入时，系统只能使用“即将截止”“名额有限”“价格优惠”等模糊表述，不得编造具体数字。
