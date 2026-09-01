import { SAR_CLUB_STORAGE_KEY, readSARClubState } from './sarClub';
import { SAR_GACHA_STORAGE_KEY, readSARGachaState } from './sarGacha';

// 与 sarSimulation.ts 的公开键保持一致。这里故意不反向 import 推演执行器，
// 避免 OSContext 的备份入口把整条聊天 Prompt / LLM 管线提前拉进启动包。
const SAR_SIMULATION_STORAGE_KEY = 'vr_sar_simulations_v1';

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export type SARLocalBackup = {
    version: 1;
    club?: unknown;
    gacha?: unknown;
    simulations?: unknown;
};

const has = (storage: Pick<Storage, 'getItem'>, key: string) => storage.getItem(key) !== null;

export const collectSARLocalBackup = (storage: StorageLike = localStorage): SARLocalBackup => {
    const backup: SARLocalBackup = { version: 1 };
    if (has(storage, SAR_CLUB_STORAGE_KEY)) backup.club = readSARClubState(storage);
    if (has(storage, SAR_GACHA_STORAGE_KEY)) backup.gacha = readSARGachaState(storage);
    if (has(storage, SAR_SIMULATION_STORAGE_KEY)) {
        try { backup.simulations = JSON.parse(storage.getItem(SAR_SIMULATION_STORAGE_KEY) || 'null'); }
        catch { backup.simulations = { version: 1, records: [] }; }
    }
    return backup;
};

export const restoreSARLocalBackup = (
    backup: SARLocalBackup | undefined,
    options: { replaceMissing: boolean },
    storage: StorageLike = localStorage,
) => {
    const restoreOne = (key: string, value: unknown) => {
        if (value !== undefined) storage.setItem(key, JSON.stringify(value));
        else if (options.replaceMissing) storage.removeItem(key);
    };
    restoreOne(SAR_CLUB_STORAGE_KEY, backup?.club);
    restoreOne(SAR_GACHA_STORAGE_KEY, backup?.gacha);
    restoreOne(SAR_SIMULATION_STORAGE_KEY, backup?.simulations);
};
