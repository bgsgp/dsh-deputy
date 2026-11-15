// 动作模型：所有对外暴露的行为都走这一个类型，便于录制、重放、审计
export const KIND = {
  UIA: 'uia',        // 原生 pattern（最稳）
  INPUT: 'input',    // SendInput 键鼠
  SHELL: 'shell',    // 启停进程 / 打开文件
  WAIT: 'wait',      // 显式等待（比盲重试安全）
}

/**
 * @param {'uia'|'input'|'shell'|'wait'} kind
 * @param {object} payload
 * @param {{expect?:number,roi?:object}} verify
 */
export function action(kind, payload, verify = {}) {
  return { kind, payload, verify: { expect: verify.expect ?? 0.02, ...verify }, id: payload.id ?? null }
}

export function invoke(ref) {
  return action(KIND.UIA, { op: 'invoke', ref })
}

export function setValue(ref, text) {
  return action(KIND.UIA, { op: 'setValue', ref, text }, { expect: 0.03 })
}

export function click(x, y, { button = 'left', clicks = 1 } = {}) {
  return action(KIND.INPUT, { op: 'click', x, y, button, clicks })
}

export function typeText(text) {
  return action(KIND.INPUT, { op: 'type', text }, { expect: 0.03 })
}

export function key(combo) {
  return action(KIND.INPUT, { op: 'key', combo })
}

export function wait(ms) {
  return action(KIND.WAIT, { op: 'wait', ms }, { expect: 0 })
}

/** 序列化为可回放的 JSONL 行，审计和复现都靠它 */
export function serialize(a, meta = {}) {
  return JSON.stringify({ ts: Date.now(), ...a, ...meta })
}
