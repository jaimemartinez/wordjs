"use client";

import { useEffect, useState } from "react";
import { PageHeader, Card, Button, Select, TimePicker } from "@/components/ui";
import { backupsApi, settingsApi, BackupFile } from "@/lib/api";
import { format } from "date-fns";
import { useModal } from "@/contexts/ModalContext";
import { useToast } from "@/contexts/ToastContext";
import { useI18n } from "@/contexts/I18nContext";

export default function BackupsPage() {
    const { t } = useI18n();
    const [backups, setBackups] = useState<BackupFile[]>([]);
    const [loading, setLoading] = useState(true);
    const [creating, setCreating] = useState(false);

    // Scheduler State
    const [schedule, setSchedule] = useState("daily");
    const [scheduleTime, setScheduleTime] = useState("00:00");
    const [scheduleDay, setScheduleDay] = useState("1"); // Default Monday

    // Track original state for "dirty" check
    const [originalSettings, setOriginalSettings] = useState({
        schedule: "daily",
        time: "00:00",
        day: "1"
    });

    const [savingSchedule, setSavingSchedule] = useState(false);

    // removing local restoring state as useModal handles it
    const [error, setError] = useState<string | null>(null);

    const { confirm } = useModal();
    const { addToast } = useToast();

    const fetchBackups = async () => {
        try {
            const data = await backupsApi.list();
            setBackups(data);
            setError(null);
        } catch (err: any) {
            setError(err.message);
            addToast(t('backups.toast.loadFailed'), "error");
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchBackups();
        fetchSchedule();
    }, []);

    const fetchSchedule = async () => {
        try {
            const settings = await settingsApi.getAll();
            const newSettings = {
                schedule: settings.backup_schedule || "daily",
                time: settings.backup_time || "00:00",
                day: settings.backup_day ? settings.backup_day.toString() : "1"
            };

            setSchedule(newSettings.schedule);
            setScheduleTime(newSettings.time);
            setScheduleDay(newSettings.day);
            setOriginalSettings(newSettings);
        } catch (e) {
            console.error("Failed to load backup schedule", e);
        }
    };

    const hasChanges =
        schedule !== originalSettings.schedule ||
        scheduleTime !== originalSettings.time ||
        scheduleDay !== originalSettings.day;

    const handleSaveChanges = async () => {
        setSavingSchedule(true);
        try {
            await settingsApi.update({
                backup_schedule: schedule,
                backup_time: scheduleTime,
                backup_day: scheduleDay
            });

            setOriginalSettings({
                schedule,
                time: scheduleTime,
                day: scheduleDay
            });

            addToast(t('backups.toast.scheduleSaved'), "success");
        } catch (err: any) {
            addToast(t('backups.toast.scheduleSaveFailed') + err.message, "error");
        } finally {
            setSavingSchedule(false);
        }
    };

    const handleCreate = async () => {
        setCreating(true);
        try {
            await backupsApi.create();
            addToast(t('backups.toast.created'), "success");
            await fetchBackups();
        } catch (err: any) {
            setError(err.message);
            addToast(err.message || t('backups.toast.createFailed'), "error");
        } finally {
            setCreating(false);
        }
    };

    const handleDelete = async (filename: string) => {
        const confirmed = await confirm(
            t('backups.delete.confirm'),
            t('backups.delete.title'),
            true // isDanger
        );

        if (!confirmed) return;

        try {
            await backupsApi.delete(filename);
            setBackups(backups.filter(b => b.filename !== filename));
            addToast(t('backups.toast.deleted'), "success");
        } catch (err: any) {
            addToast(err.message || t('backups.toast.deleteFailed'), "error");
        }
    };

    const handleRestore = async (filename: string) => {
        const confirmed = await confirm(
            t('backups.restore.confirm').replace('{filename}', filename),
            t('backups.restore.title'),
            true // isDanger
        );

        if (!confirmed) return;

        try {
            setLoading(true); // Show full page loading (or overlay)
            await backupsApi.restore(filename);
            addToast(t('backups.toast.restored'), "success");

            // Reload after a short delay to allow toast to be seen, or immediately
            setTimeout(() => {
                window.location.reload();
            }, 1000);
        } catch (err: any) {
            addToast(t('backups.toast.restoreFailed') + err.message, "error");
            setLoading(false);
        }
    };

    const formatSize = (bytes: number) => {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    };

    return (
        <div className="p-8 md:p-12 h-full bg-gray-50/50 overflow-auto">
            <PageHeader
                title={t('backups.title')}
                subtitle={t('backups.subtitle')}
                icon="fa-box-archive"
            />

            {error && (
                <div className="mb-6 p-4 bg-red-50 text-red-600 rounded-xl border border-red-100 flex items-center gap-3">
                    <i className="fa-solid fa-triangle-exclamation"></i>
                    {error}
                </div>
            )}

            <div className="flex justify-end mb-6">
                <Button
                    onClick={handleCreate}
                    disabled={creating}
                    className="bg-blue-600 hover:bg-blue-700 text-white"
                >
                    {creating ? (
                        <><i className="fa-solid fa-spinner fa-spin mr-2"></i> {t('backups.creating')}</>
                    ) : (
                        <><i className="fa-solid fa-plus mr-2"></i> {t('backups.create')}</>
                    )}
                </Button>
            </div>

            {/* Scheduler Card */}
            <Card className="rounded-[40px] border-none shadow-sm mb-8 p-8" overflow="visible">
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
                    <div>
                        <h3 className="text-xl font-bold text-gray-800 mb-2">
                            <i className="fa-solid fa-calendar-days text-blue-500 mr-3"></i>
                            {t('backups.schedule.title')}
                        </h3>
                        <p className="text-gray-500">
                            {t('backups.schedule.description')}
                        </p>
                    </div>

                    <div className="flex flex-wrap items-center gap-4">
                        <div className="flex flex-wrap items-center gap-4 bg-gray-50 p-2 rounded-2xl border border-gray-100">
                            <div className="w-56">
                                <Select
                                    value={schedule}
                                    onChange={setSchedule}
                                    options={[
                                        { value: "off", label: t('backups.frequency.off') },
                                        { value: "hourly", label: t('backups.frequency.hourly') },
                                        { value: "twicedaily", label: t('backups.frequency.twicedaily') },
                                        { value: "daily", label: t('backups.frequency.daily') },
                                        { value: "weekly", label: t('backups.frequency.weekly') }
                                    ]}
                                />
                            </div>

                            {/* Day Picker for Weekly */}
                            {schedule === 'weekly' && (
                                <div className="w-40 animate-in fade-in slide-in-from-left-2 duration-300">
                                    <Select
                                        value={scheduleDay}
                                        onChange={setScheduleDay}
                                        options={[
                                            { value: "1", label: t('backups.day.monday') },
                                            { value: "2", label: t('backups.day.tuesday') },
                                            { value: "3", label: t('backups.day.wednesday') },
                                            { value: "4", label: t('backups.day.thursday') },
                                            { value: "5", label: t('backups.day.friday') },
                                            { value: "6", label: t('backups.day.saturday') },
                                            { value: "0", label: t('backups.day.sunday') }
                                        ]}
                                    />
                                </div>
                            )}

                            {/* Time Picker for Daily/Weekly */}
                            {(schedule === 'daily' || schedule === 'weekly') && (
                                <div className="animate-in fade-in slide-in-from-left-2 duration-300">
                                    <TimePicker
                                        value={scheduleTime}
                                        onChange={setScheduleTime}
                                    />
                                </div>
                            )}
                        </div>

                        {/* Save Button */}
                        {hasChanges && (
                            <div className="animate-in fade-in slide-in-from-left-2 duration-300">
                                <Button
                                    onClick={handleSaveChanges}
                                    disabled={savingSchedule}
                                    className="bg-blue-600 hover:bg-blue-700 text-white shadow-lg"
                                >
                                    {savingSchedule ? (
                                        <i className="fa-solid fa-spinner fa-spin"></i>
                                    ) : (
                                        <>{t('backups.save')} <i className="fa-solid fa-check ml-2"></i></>
                                    )}
                                </Button>
                            </div>
                        )}
                    </div>
                </div>
            </Card>

            <Card className="rounded-[40px] border-none shadow-sm">
                <div className="overflow-x-auto">
                    <table className="w-full">
                        <thead>
                            <tr className="border-b border-gray-100/50 text-left">
                                <th className="p-6 text-xs uppercase tracking-wider text-gray-400 font-bold">{t('backups.column.filename')}</th>
                                <th className="p-6 text-xs uppercase tracking-wider text-gray-400 font-bold">{t('backups.column.date')}</th>
                                <th className="p-6 text-xs uppercase tracking-wider text-gray-400 font-bold">{t('backups.column.size')}</th>
                                <th className="p-6 text-xs uppercase tracking-wider text-gray-400 font-bold text-right">{t('backups.column.actions')}</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-50">
                            {loading ? (
                                <tr>
                                    <td colSpan={4} className="p-12 text-center text-gray-400">
                                        <i className="fa-solid fa-spinner fa-spin text-2xl mb-3"></i>
                                        <p>{t('backups.loading')}</p>
                                    </td>
                                </tr>
                            ) : backups.length === 0 ? (
                                <tr>
                                    <td colSpan={4} className="p-12 text-center text-gray-400">
                                        <div className="w-16 h-16 bg-gray-50 rounded-full flex items-center justify-center mx-auto mb-4">
                                            <i className="fa-solid fa-box-open text-2xl text-gray-300"></i>
                                        </div>
                                        <p className="font-medium">{t('backups.empty.title')}</p>
                                        <p className="text-sm mt-1">{t('backups.empty.description')}</p>
                                    </td>
                                </tr>
                            ) : (
                                backups.map((backup) => (
                                    <tr key={backup.filename} className="hover:bg-gray-50/50 transition-colors group">
                                        <td className="p-6 font-medium text-gray-700">
                                            <div className="flex items-center gap-3">
                                                <div className="w-10 h-10 rounded-xl bg-blue-50 text-blue-500 flex items-center justify-center">
                                                    <i className="fa-solid fa-file-zipper"></i>
                                                </div>
                                                {backup.filename}
                                            </div>
                                        </td>
                                        <td className="p-6 text-gray-500 text-sm">
                                            {format(new Date(backup.date), "PPP p")}
                                        </td>
                                        <td className="p-6 text-gray-500 text-sm font-mono">
                                            {formatSize(backup.size)}
                                        </td>
                                        <td className="p-6 text-right">
                                            <div className="flex items-center justify-end gap-2 opacity-100 focus-within:opacity-100 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100 transition-opacity">
                                                <button
                                                    onClick={() => backupsApi.download(backup.filename)}
                                                    className="p-2 hover:bg-blue-50 text-blue-600 rounded-lg transition-colors"
                                                    title={t('backups.action.download')}
                                                >
                                                    <i className="fa-solid fa-download"></i>
                                                </button>
                                                <button
                                                    onClick={() => handleRestore(backup.filename)}
                                                    className="p-2 hover:bg-orange-50 text-orange-500 rounded-lg transition-colors"
                                                    title={t('backups.action.restore')}
                                                >
                                                    <i className="fa-solid fa-clock-rotate-left"></i>
                                                </button>
                                                <button
                                                    onClick={() => handleDelete(backup.filename)}
                                                    className="p-2 hover:bg-red-50 text-red-500 rounded-lg transition-colors"
                                                    title={t('backups.action.delete')}
                                                >
                                                    <i className="fa-solid fa-trash"></i>
                                                </button>
                                            </div>
                                        </td>
                                    </tr>
                                ))
                            )}
                        </tbody>
                    </table>
                </div>
            </Card>
        </div>
    );
}
