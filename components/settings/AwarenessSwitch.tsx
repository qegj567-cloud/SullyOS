import React from 'react';
import './awarenessSwitch.css';

type Props = Pick<React.InputHTMLAttributes<HTMLInputElement>, 'checked' | 'disabled' | 'onChange'> & { 'aria-label': string };

export default function AwarenessSwitch(props: Props) {
    return <input {...props} type="checkbox" role="switch" className="awareness-switch" />;
}
