import React, { useMemo } from 'react';
import { Select } from './Select';

interface TimePickerProps {
    value: string;
    onChange: (value: string) => void;
    disabled?: boolean;
}

export function TimePicker({ value, onChange, disabled }: TimePickerProps) {
    // Parse HH:mm (24h)
    const [hours, minutes] = value ? value.split(':') : ['00', '00'];

    // Generate options
    const hourOptions = useMemo(() =>
        Array.from({ length: 24 }, (_, i) => {
            const val = i.toString().padStart(2, '0');
            return { value: val, label: val };
        })
        , []);

    const minuteOptions = useMemo(() =>
        Array.from({ length: 60 }, (_, i) => {
            const val = i.toString().padStart(2, '0');
            return { value: val, label: val };
        })
        , []);

    const handleHourChange = (newHour: string) => {
        onChange(`${newHour}:${minutes}`);
    };

    const handleMinuteChange = (newMinute: string) => {
        onChange(`${hours}:${newMinute}`);
    };

    return (
        <div className="flex items-center gap-2">
            <div className="w-20">
                <Select
                    value={hours}
                    onChange={handleHourChange}
                    options={hourOptions}
                    disabled={disabled}
                    className="text-center"
                />
            </div>
            <span className="text-gray-400 font-bold">:</span>
            <div className="w-20">
                <Select
                    value={minutes}
                    onChange={handleMinuteChange}
                    options={minuteOptions}
                    disabled={disabled}
                    className="text-center"
                />
            </div>
        </div>
    );
}
