import React from 'react';
import type { OSTheme } from '../../types';
import ClassicBootSequence from './ClassicBootSequence';
import JellyfishBootSequence from './JellyfishBootSequence';

interface Props {
  dataReady: boolean;
  wallpaper?: string;
  style?: OSTheme['bootAnimationStyle'];
  onDone: () => void;
}
export default function BootSequence({style, ...props}: Props) {
  return style === 'classic' ? <ClassicBootSequence {...props} /> : <JellyfishBootSequence {...props} />;
}
