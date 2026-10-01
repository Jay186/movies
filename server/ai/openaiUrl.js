// OpenAI 兼容 URL 归一：消除用户把 baseURL 填成「裸域名」或「已带 /v1」两种写法时的 /v1/v1 风险。
// 启明星是 OpenAI 兼容聚合中转站：文本 /v1/chat/completions、生图 /v1/images/generations。

// 去掉尾部斜杠；若结尾是 /v1 再去掉一层，得到「根地址」。
export function openaiRoot(u) {
  let s = String(u || '').trim().replace(/\/+$/, '')
  s = s.replace(/\/v1$/i, '')
  return s.replace(/\/+$/, '')
}

export function openaiChatUrl(baseURL) {
  return `${openaiRoot(baseURL)}/v1/chat/completions`
}

export function openaiImagesGenerationsUrl(baseURL) {
  return `${openaiRoot(baseURL)}/v1/images/generations`
}

export function openaiImagesEditsUrl(baseURL) {
  return `${openaiRoot(baseURL)}/v1/images/edits`
}

export function openaiModelsUrl(baseURL) {
  return `${openaiRoot(baseURL)}/v1/models`
}
