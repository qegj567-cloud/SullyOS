
import React from 'react';
import { OSProvider } from './context/OSContext';
import PhoneShell from './components/PhoneShell';
import EmergencyNetlifyPopup from './components/os/EmergencyNetlifyPopup';
import { isIOSStandaloneWebApp } from './utils/iosStandalone';

const App: React.FC = () => {
  const useAbsoluteShell = typeof window !== 'undefined' && isIOSStandaloneWebApp();
  const shellClassName = useAbsoluteShell
    ? 'fixed inset-0 w-full h-full bg-transparent overflow-hidden'
    : 'relative w-full bg-transparent overflow-hidden';
  const shellStyle = useAbsoluteShell
    ? { height: 'var(--app-height, 100lvh)', minHeight: 'var(--app-height, 100lvh)' }
    : { height: 'var(--app-height, 100lvh)', minHeight: 'var(--app-height, 100lvh)' };

  return (
    <div
      className={shellClassName}
      style={shellStyle}
    >
      <div
        className={`${useAbsoluteShell ? 'absolute' : 'fixed'} inset-0 w-full h-full z-0 bg-transparent`}
        style={{ transform: 'translateZ(0)' }}
      >
        <OSProvider>
          <PhoneShell />
          <EmergencyNetlifyPopup />
        </OSProvider>
      </div>
    </div>
  );
};

export default App;
