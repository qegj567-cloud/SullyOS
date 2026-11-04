import { describe, it, expect } from 'vitest';
import { stripSensitiveCardFields, CARD_STRIPPED_FIELDS } from './characterCard';

describe('stripSensitiveCardFields', () => {
  it('剥离所有内嵌 API 密钥（导出绝不泄漏凭据）', () => {
    const card = {
      name: '小明',
      systemPrompt: '你是小明',
      emotionConfig: { enabled: true, api: { baseUrl: 'https://x', apiKey: 'sk-SECRET', model: 'gpt' } },
      embeddingConfig: { baseUrl: 'https://x', apiKey: 'sk-SECRET2', model: 'emb', dimensions: 1024 },
      proactiveConfig: { enabled: true, intervalMinutes: 60, secondaryApi: { baseUrl: 'https://x', apiKey: 'sk-SECRET3', model: 'gpt' } },
      activeMsg2Config: { enabled: true, secondaryApi: { apiKey: 'sk-SECRET4' } },
    };

    const out = stripSensitiveCardFields(card);
    const json = JSON.stringify(out);

    expect(out.name).toBe('小明');
    expect(out.systemPrompt).toBe('你是小明');
    expect(json).not.toContain('sk-SECRET');
    expect(out).not.toHaveProperty('emotionConfig');
    expect(out).not.toHaveProperty('embeddingConfig');
    expect(out).not.toHaveProperty('proactiveConfig');
    expect(out).not.toHaveProperty('activeMsg2Config');
  });

  it('剥离美化 / 语言 / 运行时状态，保留角色本身', () => {
    const card = {
      name: '小红',
      systemPrompt: 'sp',
      worldview: '世界观',
      sprites: { happy: 'data:img' },
      // 美化
      bubbleStyle: 'theme-1',
      chatFineTune: { enabled: true, chatBubbleFontSize: 14 },
      chromeCustomCss: '.x{}',
      embeddedTheme: { id: 't1' },
      chatBackground: 'bg',
      // 语言
      chatVoiceLang: 'ja',
      dateVoiceLang: 'en',
      memoryPalaceWaterline: { preset: 'offline' },
      // 运行时状态
      activeBuffs: [{ id: 'b1' }],
      buffInjection: '（开心）',
      phoneState: { records: [] },
      savedDateState: { foo: 1 },
      videoCallPerformancePersona: '只在本机使用的表演人格摘要',
      videoCallPerformancePersonaGeneratedAt: 123456,
      companionTouchSettings: { enabledZones: ['head'], reactions: { head: [{ id: 'head-1', text: '私人台词', performance: {} }] } },
    };

    const out = stripSensitiveCardFields(card);

    // 角色本身保留
    expect(out.name).toBe('小红');
    expect(out.worldview).toBe('世界观');
    expect(out.sprites).toEqual({ happy: 'data:img' });

    // 全部被剥离
    for (const key of ['bubbleStyle', 'chatFineTune', 'chromeCustomCss', 'embeddedTheme', 'chatBackground',
      'chatVoiceLang', 'dateVoiceLang', 'activeBuffs', 'buffInjection', 'phoneState', 'savedDateState',
      'videoCallPerformancePersona', 'videoCallPerformancePersonaGeneratedAt', 'companionTouchSettings']) {
      expect(out).not.toHaveProperty(key);
    }
  });

  it('不修改原对象（返回浅拷贝）', () => {
    const card = { name: 'x', emotionConfig: { enabled: true, api: { apiKey: 'sk' } } };
    stripSensitiveCardFields(card);
    expect(card).toHaveProperty('emotionConfig');
  });

  it('对缺失字段安全（不会抛错）', () => {
    expect(() => stripSensitiveCardFields({ name: 'x' })).not.toThrow();
    expect(stripSensitiveCardFields({ name: 'x' })).toEqual({ name: 'x' });
  });

  it('清单覆盖四类敏感字段', () => {
    for (const k of ['emotionConfig', 'embeddingConfig', 'bubbleStyle', 'chatVoiceLang', 'memoryPalaceWaterline', 'activeBuffs', 'phoneState']) {
      expect(CARD_STRIPPED_FIELDS).toContain(k);
    }
  });
});


it('角色分享卡不携带家园私人数据或同步版本，也不修改本机原档',()=>{
 const card={name:'角色',home3D:{records:[{text:'秘密'}]},homeDefinition:{notes:'私密设定'},homeContextBridgeVersion:3,chibiStudio:{home3D:{state:{selected:{eyes:'自绘'}}}}};
 const before=structuredClone(card),out=stripSensitiveCardFields(card);
 expect(out).toEqual({name:'角色'});expect(card).toEqual(before);
});

it('角色分享卡不携带聊天备注与 RECALL 提示开关，备注内容照常保留', () => {
  const card = { name: '小明', description: '一段很长的角色介绍', chatShowRemark: true, hideMonthlyRecallPrompt: false };
  const out = stripSensitiveCardFields(card);
  expect(out).toEqual({ name: '小明', description: '一段很长的角色介绍' });
});
