import type { DecorationPreset } from '../../utils/chatDecoration';
import css from './silver-halo.css?raw';

const voice = {
    voiceBarBg: '#f4f3f8',
    voiceBarActiveBg: '#e7e6ef',
    voiceBarBtnColor: '#d8d6e3',
    voiceBarWaveColor: '#686c82',
    voiceBarTextColor: '#34394e',
};

const silverHalo: DecorationPreset = {
    format: 'sullyos-chat-decoration',
    version: 1,
    name: '银晕',
    parts: {
        layout: {
            chatAvatarMode: 'every_message', chatAvatarShape: 'circle', chatAvatarSize: 'medium',
            chatAvatarVisibility: 'both', chatAvatarPlacement: 'beside', chatAvatarAlign: 'top',
            chatAvatarOffsetY: 0, chatSnapToEdge: false, chatBubbleIndent: 0,
            chatBubbleStyle: 'flat', chatMessageSpacing: 'default',
            chatShowTimestamp: 'always', chatTimestampPosition: 'below_avatar',
            chatHeaderStyle: 'default', chatChromeStyle: 'soft', chatHeaderAlign: 'left',
            chatHeaderDensity: 'airy', chatHideHeaderBuffs: false, chatStatusStyle: 'dot',
            chatInputStyle: 'rounded', chatSendButtonStyle: 'circle', chatModuleAlign: 'center',
        },
        bubbles: {
            id: 'silver-halo', name: '银晕', type: 'custom',
            ai: { ...voice, textColor: '#202536', backgroundColor: '#f4f3f8', borderRadius: 0, opacity: 1, tailMode: 'none' },
            user: { ...voice, textColor: '#f8f7fb', backgroundColor: '#4a4e60', borderRadius: 0, opacity: 1, tailMode: 'none' },
        },
        background: { image: null, style: 'plain' },
        psyche: { styleId: 'minimal' },
        css,
    },
};

export default silverHalo;
