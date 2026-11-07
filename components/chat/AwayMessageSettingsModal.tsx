import React, { useEffect, useState } from 'react';
import Modal from '../os/Modal';
import { CharacterProfile } from '../../types';
import { AWAY_DELAY_OPTIONS, resolveAwayDelayMinutes } from '../../utils/awayMessageCore';
import { isAwayCloudRoute } from '../../utils/awayMessage';

interface AwayMessageSettingsModalProps {
    isOpen: boolean;
    onClose: () => void;
    char: CharacterProfile;
    onSave: (config: NonNullable<CharacterProfile['awayMessage']>) => void;
}

const formatDelay = (minutes: number) => minutes < 60 ? `${minutes} 分钟` : `${minutes / 60} 小时`;

const AwayMessageSettingsModal: React.FC<AwayMessageSettingsModalProps> = ({ isOpen, onClose, char, onSave }) => {
    const [enabled, setEnabled] = useState(!!char.awayMessage?.enabled);
    const [delay, setDelay] = useState(resolveAwayDelayMinutes(char));
    const [cloud, setCloud] = useState<boolean | null>(null);

    useEffect(() => {
        if (!isOpen) return;
        setEnabled(!!char.awayMessage?.enabled);
        setDelay(resolveAwayDelayMinutes(char));
        let cancelled = false;
        void isAwayCloudRoute(char).then(v => { if (!cancelled) setCloud(v); });
        return () => { cancelled = true; };
    }, [isOpen, char]);

    const handleSave = () => {
        onSave({ enabled, delayMinutes: delay });
        onClose();
    };

    return (
        <Modal isOpen={isOpen} title="离开后消息" onClose={onClose} footer={
            <>
                <button onClick={onClose} className="flex-1 py-3 bg-slate-100 text-slate-500 font-bold rounded-2xl active:scale-95 transition-transform">
                    取消
                </button>
                <button onClick={handleSave} className="flex-1 py-3 bg-violet-500 text-white font-bold rounded-2xl active:scale-95 transition-transform shadow-lg">
                    保存
                </button>
            </>
        }>
            <div className="space-y-5">
                <p className="text-xs text-slate-400 leading-relaxed">
                    你超过设定的时间没说话，{char.name} 就会来找你。一次离开只找一次，你开口后重新计时。
                </p>

                <div className="flex items-center justify-between">
                    <span className="text-sm font-bold text-slate-700">启用离开后消息</span>
                    <button
                        onClick={() => setEnabled(!enabled)}
                        className={`w-12 h-7 rounded-full transition-colors relative ${enabled ? 'bg-violet-500' : 'bg-slate-200'}`}
                    >
                        <span className={`absolute top-0.5 left-0.5 w-6 h-6 bg-white rounded-full shadow transition-all duration-200 ${enabled ? 'translate-x-5' : 'translate-x-0'}`} />
                    </button>
                </div>

                {enabled && (
                    <>
                        <div>
                            <label className="text-sm font-bold text-slate-700 block mb-2">离开多久后</label>
                            <div className="grid grid-cols-4 gap-2">
                                {AWAY_DELAY_OPTIONS.map(minutes => (
                                    <button
                                        key={minutes}
                                        onClick={() => setDelay(minutes)}
                                        className={`py-2 px-1 rounded-xl text-xs font-bold transition-all ${delay === minutes
                                            ? 'bg-violet-500 text-white shadow-md'
                                            : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
                                        }`}
                                    >
                                        {formatDelay(minutes)}
                                    </button>
                                ))}
                            </div>
                        </div>

                        <p className="pt-2 border-t border-slate-100 text-[11px] text-slate-400 leading-relaxed">
                            {cloud === null ? '' : cloud
                                ? `${char.name} 开着主动消息 2.0：到时间会直接推送给你。这一次算作「没回时找你」，受主动频率里的上限管。`
                                : `你下次打开 SullyOS 时，${char.name} 会补上你不在时发的消息。每次打开，每个开了这项的角色会调一次聊天 API。`}
                        </p>
                    </>
                )}
            </div>
        </Modal>
    );
};

export default React.memo(AwayMessageSettingsModal);
