// Thin async wrapper around systemd-logind's scheduled shutdown API.
//
// logind owns the timer, so a scheduled shutdown survives the extension being
// disabled (screen lock, shell restart) and is shared with `shutdown +N`.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const BUS_NAME = 'org.freedesktop.login1';
const OBJECT_PATH = '/org/freedesktop/login1';
const MANAGER_IFACE = 'org.freedesktop.login1.Manager';
const PROPERTIES_IFACE = 'org.freedesktop.DBus.Properties';

// Leave time for a polkit password prompt when other users are logged in.
const INTERACTIVE_TIMEOUT_MS = 120 * 1000;

export function isCancelledError(error) {
    return error instanceof GLib.Error &&
        error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

export class LoginManager {
    constructor() {
        this._cancellable = new Gio.Cancellable();
        this._signalId = 0;
    }

    /**
     * Calls `callback` when logind reports that the scheduled shutdown changed.
     *
     * @param {Function} callback
     */
    watch(callback) {
        this._signalId = Gio.DBus.system.signal_subscribe(
            BUS_NAME,
            PROPERTIES_IFACE,
            'PropertiesChanged',
            OBJECT_PATH,
            MANAGER_IFACE,
            Gio.DBusSignalFlags.NONE,
            (_connection, _sender, _path, _iface, _signal, params) => {
                const [, changed, invalidated] = params.deepUnpack();
                if ('ScheduledShutdown' in changed || invalidated.includes('ScheduledShutdown'))
                    callback();
            });
    }

    /**
     * @returns {Promise<{type: string, deadline: number}|null>} the deadline is
     *   in CLOCK_REALTIME microseconds, like GLib.get_real_time()
     */
    async getScheduledShutdown() {
        const reply = await this._call(
            PROPERTIES_IFACE,
            'Get',
            new GLib.Variant('(ss)', [MANAGER_IFACE, 'ScheduledShutdown']),
            '(v)');
        const value = reply.get_child_value(0).get_variant();
        const [type] = value.get_child_value(0).get_string();

        // logind reports "nothing scheduled" with ("", UINT64_MAX). Check the type
        // first: unpacking UINT64_MAX makes GJS log a precision warning.
        if (!type)
            return null;

        const deadline = value.get_child_value(1).get_uint64();
        if (!deadline || deadline > Number.MAX_SAFE_INTEGER)
            return null;

        return {type, deadline};
    }

    /**
     * Schedules (or replaces) a power action at `deadline`.
     *
     * @param {number} deadline CLOCK_REALTIME microseconds
     * @param {string} type logind action: "poweroff", "reboot", …
     * @param {boolean} dryRun schedule a logind dry run that never powers off
     */
    async schedule(deadline, type, dryRun) {
        await this._call(
            MANAGER_IFACE,
            'ScheduleShutdown',
            new GLib.Variant('(st)', [dryRun ? `dry-${type}` : type, Math.round(deadline)]),
            null,
            Gio.DBusCallFlags.ALLOW_INTERACTIVE_AUTHORIZATION,
            INTERACTIVE_TIMEOUT_MS);
    }

    async cancel() {
        await this._call(
            MANAGER_IFACE,
            'CancelScheduledShutdown',
            null,
            '(b)',
            Gio.DBusCallFlags.ALLOW_INTERACTIVE_AUTHORIZATION,
            INTERACTIVE_TIMEOUT_MS);
    }

    destroy() {
        this._cancellable.cancel();

        if (this._signalId) {
            Gio.DBus.system.signal_unsubscribe(this._signalId);
            this._signalId = 0;
        }
    }

    _call(iface, method, params, replyType, flags = Gio.DBusCallFlags.NONE, timeout = -1) {
        return new Promise((resolve, reject) => {
            Gio.DBus.system.call(
                BUS_NAME,
                OBJECT_PATH,
                iface,
                method,
                params,
                replyType ? new GLib.VariantType(replyType) : null,
                flags,
                timeout,
                this._cancellable,
                (connection, result) => {
                    try {
                        resolve(connection.call_finish(result));
                    } catch (error) {
                        reject(error);
                    }
                });
        });
    }
}
