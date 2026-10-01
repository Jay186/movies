import fs from 'node:fs'

function normalizeWorkflowDocument(document = {}) {
  if (Array.isArray(document.nodes)) return { kind: 'ui', nodes: document.nodes, links: document.links || [], id: document.id, revision: document.revision, last_node_id: document.last_node_id }
  const nodes = Object.entries(document || {}).filter(([key, value]) => /^\d+$/.test(key) && value && typeof value === 'object').map(([id, value]) => ({ id: Number(id), type: value.class_type, title: value._meta?.title || '', inputs: Object.keys(value.inputs || {}).map((name) => ({ name, type: '', link: Array.isArray(value.inputs[name]) ? value.inputs[name] : null })), apiInputs: value.inputs || {} }))
  return { kind: 'api', nodes, links: [], id: document.id || '', revision: document.revision ?? null, last_node_id: Math.max(0, ...nodes.map((node) => node.id)) }
}

export function inspectH3WorkflowDocument(document = {}, mapping = {}) {
  const normalized = normalizeWorkflowDocument(document)
  const nodes = new Map(normalized.nodes.map((node) => [Number(node.id), node]))
  const links = new Map((normalized.links || []).map((link) => [Number(Array.isArray(link) ? link[0] : link.id), link]))
  const findings = []
  const check = (field, expectedType = '') => {
    const map = mapping[field]
    if (!map?.nodeId) return
    const node = nodes.get(Number(map.nodeId))
    if (!node) {
      findings.push({ level: 'error', field, code: 'WORKFLOW_NODE_MISSING', nodeId: String(map.nodeId) })
      return
    }
    const input = (node.inputs || []).find((item) => item.name === map.fieldName)
    const apiInputPresent = normalized.kind === 'api' && node.apiInputs && Object.prototype.hasOwnProperty.call(node.apiInputs, map.fieldName)
    const canWrite = normalized.kind === 'api' ? apiInputPresent : Boolean(input)
    if (!canWrite) findings.push({ level: 'error', field, code: 'WORKFLOW_INPUT_MISSING', nodeId: String(map.nodeId), fieldName: map.fieldName })
    if (expectedType && input?.type && !String(input.type).includes(expectedType)) {
      findings.push({ level: 'warn', field, code: 'WORKFLOW_INPUT_TYPE_UNEXPECTED', nodeId: String(map.nodeId), fieldName: map.fieldName, actual: input.type })
    }
  }
  const expectedTypes = { prompt: 'STRING', duration: 'FLOAT', aspectRatio: 'COMBO', megapixels: 'FLOAT', video: 'VIDEO', vcSwitchC: 'BOOLEAN', vcSwitchL: 'BOOLEAN' }
  for (const field of Object.keys(mapping)) {
    const expected = expectedTypes[field]
    if (field.startsWith('image')) check(field, 'IMAGE')
    else if (field.startsWith('audio')) check(field, 'AUDIO')
    else check(field, expected || '')
  }
  const present = [...nodes.keys()]
  return {
    ok: findings.every((item) => item.level !== 'error'),
    workflowId: document.id || '',
    revision: document.revision ?? null,
    lastNodeId: document.last_node_id ?? null,
    nodeCount: present.length,
    findings,
    checkedFields: Object.keys(mapping),
    sourceIsLocalExport: true,
    onlineWorkflowId: null,
  }
}

export function inspectH3WorkflowFile(filePath, mapping) {
  const document = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  return inspectH3WorkflowDocument(document, mapping)
}
