import type { CharacterProfile } from '../../types';
import { allowsAutomaticVR } from './participation';

/** Only free-roaming participants can be encountered by chance. Manual invitations stay explicit. */
export function rollMarketVisitor(characters: CharacterProfile[], random = Math.random, allowNPCs = true): CharacterProfile | null {
    const roaming = characters.filter(char => allowsAutomaticVR(char.vrState));
    if (!roaming.length || (allowNPCs && random() < .5)) return null;
    return roaming[Math.floor(random() * roaming.length)];
}
