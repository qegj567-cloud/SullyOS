import type { CharacterProfile } from '../types';
import { companionAvatarSource, getCompanionDateSprites, hasDatePortraits } from './companionAvatar';
import { buildAvatarPerformancePrompt } from './avatarPerformance';

export function allowedLive2DCallActions(model: Extract<NonNullable<CharacterProfile['videoAvatar']>, { format: 'live2d' }>) {
  const score = (action: typeof model.actions[number]) => (action.tags?.length ? 100 : 0)
    + (action.kind === 'motion' ? 20 : action.kind === 'params' ? 15 : 10) + (action.source === 'vtube' ? 2 : 0);
  return model.actions.filter(action => action.permission === 'ai' && !action.wardrobe)
    .sort((a, b) => score(b) - score(a));
}

export type RoleCameraChoice = 'configured' | 'date' | 'chibi' | 'model';
export type RoleCameraView = Exclude<RoleCameraChoice, 'configured'> | 'upload' | 'off' | 'avatar';

export function roleChibi(char?: CharacterProfile | null) {
  return char?.sprites?.chibi || char?.vrState?.chibi?.img || char?.chibiStudio?.room?.img
    || char?.chibiStudio?.vr?.img || char?.chibiStudio?.like520?.img;
}

export function roleCameraView(char: CharacterProfile | null | undefined, choice: RoleCameraChoice, enabled: boolean): RoleCameraView {
  if (!enabled) return 'off';
  const source = choice === 'configured' ? companionAvatarSource(char) : choice;
  if (source === 'date' && hasDatePortraits(char)) return source;
  if (source === 'model' && char?.videoAvatar) return source;
  if (source === 'chibi' && roleChibi(char)) return source;
  if (source === 'upload' && char?.companionAvatar?.imageRef) return source;
  return 'avatar';
}

export function roleCameraReplyFormat(view: RoleCameraView, char?: CharacterProfile | null) {
  if (view === 'date' && char) {
    const sprites = getCompanionDateSprites(char);
    const expressions = [sprites.happy && 'emotion=happy', sprites.angry && 'emotion=angry', sprites.sad && 'emotion=sad', sprites.shy && 'face=blush'].filter(Boolean);
    if (expressions.length) return '角色画面使用见面立绘。可在台词前单独放一条 [[AVATAR: 字段]] 切换表情，字段从 emotion=neutral、' + expressions.join('、') + ' 中选一个。其余内容写可朗读台词。';
  }
  if (view === 'model') {
    const model = char?.videoAvatar;
    const actions = model?.format === 'live2d' ? (model.actions ?? []).filter(action => action.permission === 'ai' && !action.wardrobe).slice(0, 24) : [];
    return '角色画面使用动态模型。台词前可放一条演出指令，如 [[AVATAR: emotion=happy; gesture=nod]]。'
      + (actions.length ? '可选 model_action 仅限：' + actions.map(action => action.id).join('、') + '。' : '') + '随后写可朗读台词。';
  }
  return (view === 'off' ? '角色镜头已关闭。' : view === 'chibi' ? '角色画面为固定 Chibi 形象。' : '角色画面为静态形象。') + '只写台词，无需表情切换或模型演出指令。';
}

export function companionPerformanceFormat(view: RoleCameraView, char: CharacterProfile | undefined, immersive: boolean) {
  if (!immersive) return '只输出可朗读的台词。';
  if (view !== 'model') return roleCameraReplyFormat(view, char);
  const model = char?.videoAvatar;
  return buildAvatarPerformancePrompt(model?.format === 'live2d' ? allowedLive2DCallActions(model) : []);
}
