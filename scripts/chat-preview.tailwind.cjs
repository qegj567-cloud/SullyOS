module.exports = {
  content: ['./features/collaboration/CollaborationBeautySample.tsx', './apps/Launcher.tsx', './components/os/AppIcon.tsx', './components/os/NowPlayingSquareWidget.tsx', './components/schedule/ScheduleHomeWidget.tsx', './apps/JournalApp.tsx', './components/journal/JournalThemeArtwork.tsx', './components/schedule/ScheduleCard.tsx', './components/chat/**/*.{ts,tsx}', './components/sar/SARSpeechSwitch.tsx', './apps/GroupChat.tsx'],
  theme: {extend:{
    fontFamily:{sans:['var(--app-font, system-ui)','sans-serif']},
    colors:{primary:'hsl(var(--primary-hue), var(--primary-sat), var(--primary-lightness))','primary-focus':'hsl(var(--primary-hue), var(--primary-sat), calc(var(--primary-lightness) - 10%))','primary-light':'hsl(var(--primary-hue), var(--primary-sat), 92%)',surface:'rgba(255,255,255,.75)','surface-glass':'rgba(255,255,255,.35)'},
  }},
};
