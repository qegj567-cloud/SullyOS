import { INSTANT_INPUT_NAMESPACE, parseInstantInputEnvelope } from './instantInput';
import { parseToolPack } from '../../../utils/amsgToolPack';
import { parseCharCredId } from '../../../utils/amsgLlmCredentials';
import { AMSG_STATE_NAMESPACE_PREFIX, unpackStateValue } from '../../../utils/amsgFirePack';
import { isSidechannelKey } from '../../../utils/amsgClientStateDelete';
import { parsePlateJobInput } from '../../../utils/amsgPlateJob';

export interface SullyCloudResourceInput {
  type: string;
  namespace?: string;
  key?: string;
  value?: unknown;
  credId?: string;
  payload?: unknown;
  task?: unknown;
}

export interface SullyCloudOwnership {
  owner: { type: string; id: string; label?: string } | null;
  kind: string | null;
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value : undefined;

const character = (id: string, kind: string, label?: string): SullyCloudOwnership => ({
  owner: { type: 'character', id, ...(label ? { label } : {}) }, kind,
});

/** 只按云端已有的结构化身份识别；不解析正文里的人名，也不读取浏览器资料。 */
export async function resolveSullyCloudOwnership(input: SullyCloudResourceInput): Promise<SullyCloudOwnership | null> {
  if (input.type === 'state') {
    if (input.namespace === INSTANT_INPUT_NAMESPACE && typeof input.value === 'string') {
      const envelope = parseInstantInputEnvelope(input.value);
      return envelope ? character(envelope.charId, 'instant-input') : null;
    }
    if (input.namespace === 'amsg:attachments' && typeof input.value === 'string') {
      try {
        const envelope = record(JSON.parse(input.value));
        const owner = record(envelope.owner);
        const id = text(owner.id);
        if (envelope.version === 1 && owner.type === 'character' && id) return character(id, 'sidechannel');
      } catch { /* 旧异常附件没有可证明的角色归属。 */ }
      return null;
    }
    if (input.namespace?.startsWith(AMSG_STATE_NAMESPACE_PREFIX)) {
      const id = input.namespace.slice(AMSG_STATE_NAMESPACE_PREFIX.length);
      if (!id) return null;
      const kind = input.key === 'fire_pack' || input.key === 'tool_pack' ? 'context'
        : isSidechannelKey(input.key ?? '') ? 'sidechannel' : 'character-state';
      let label: string | undefined;
      if (input.key === 'tool_pack' && typeof input.value === 'string') {
        try { label = text(parseToolPack(await unpackStateValue(input.value))?.charName); } catch { /* 身份仍由命名空间确定。 */ }
      }
      return character(id, kind, label);
    }
    if (input.namespace === 'amsg:global') {
      return { owner: null, kind: 'global-state' };
    }
    if (input.namespace === 'amsg:job' && input.key?.startsWith('plate:') && typeof input.value === 'string') {
      try {
        const job = parsePlateJobInput(await unpackStateValue(input.value));
        return job ? character(job.charId, 'job-input', job.charName) : null;
      } catch { return null; }
    }
  }
  if (input.type === 'subscription') return { owner: null, kind: 'global-subscription' };
  if (input.type === 'credential') {
    const parsed = parseCharCredId(input.credId ?? '');
    return parsed ? character(parsed.charId, `credential-${parsed.purpose}`) : null;
  }
  if (input.type === 'task' || input.type === 'outbox') {
    const rawPayload = record(input.payload);
    const payload = text(record(rawPayload.metadata).charId) || text(rawPayload.charId) ? rawPayload : record(input.task);
    const metadata = record(payload.metadata);
    const id = text(metadata.charId) ?? text(payload.charId);
    if (!id) return null;
    const kind = input.type === 'outbox'
      ? text(payload.resultKind) || text(metadata.resultKind) ? 'job-result' : 'message-result'
      : text(metadata.amsgKind) ? 'background-job' : text(payload.messageSubtype) ?? 'scheduled-message';
    return character(id, kind, text(payload.contactName) ?? text(payload.charName));
  }
  return null;
}
