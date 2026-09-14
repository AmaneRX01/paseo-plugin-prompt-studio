import {
  dispatchIdSchema,
  type DispatchId,
  type DispatchTarget,
} from "./contracts";

let fallbackSequence = 0;

export function createDispatchId(): DispatchId {
  const bytes = new Uint8Array(12);
  const cryptoObject = globalThis.crypto;
  if (cryptoObject && typeof cryptoObject.getRandomValues === "function") {
    cryptoObject.getRandomValues(bytes);
  } else {
    // The ID is an idempotency token, not a credential. Modern Paseo clients
    // provide Web Crypto; this fallback only preserves uniqueness on older
    // React Native runtimes that do not expose it.
    fallbackSequence = (fallbackSequence + 1) >>> 0;
    const time = Date.now();
    for (let index = 0; index < bytes.length; index += 1) {
      const timeByte = Math.floor(time / (2 ** ((index % 6) * 8))) & 0xff;
      const sequenceByte = (fallbackSequence >>> ((index % 4) * 8)) & 0xff;
      bytes[index] = Math.floor(Math.random() * 256) ^ timeByte ^ sequenceByte;
    }
  }
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  return dispatchIdSchema.parse(`ds_${hex}`);
}

export function dispatchTargetKey(target: DispatchTarget): string {
  return target.kind === "existing_agent"
    ? JSON.stringify([target.kind, target.agentId])
    : JSON.stringify([
        target.kind,
        target.workspaceId,
        target.config.provider,
        target.config.model,
        target.config.modeId,
        target.config.thinkingOptionId,
        target.config.title,
      ]);
}

export function sameDispatchTarget(left: DispatchTarget, right: DispatchTarget): boolean {
  return dispatchTargetKey(left) === dispatchTargetKey(right);
}
