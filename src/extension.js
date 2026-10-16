// Auto Shutdown: a top bar menu for scheduling a power off.
//
// The timer itself lives in systemd-logind (see logind.js); this extension only
// shows its state, counts down, and warns before the deadline.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {CustomTimeDialog} from './dialog.js';
import {LoginManager, isCancelledError} from './logind.js';
import {cleanMinutes, formatCountdown, formatDeadline, formatDuration, formatRemaining} from './util.js';

// logind does not reliably announce schedule changes, so poll as a fallback.
const POLL_INTERVAL_SECONDS = 5;

const StatusItem = GObject.registerClass(
class StatusItem extends PopupMenu.PopupBaseMenuItem {
    _init() {
        super._init({reactive: false, can_focus: false, style_class: 'auto-shutdown-status'});

        const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        this._title = new St.Label({style_class: 'auto-shutdown-status-title'});
        this._subtitle = new St.Label({style_class: 'auto-shutdown-status-subtitle'});
        box.add_child(this._title);
        box.add_child(this._subtitle);
        this.add_child(box);
    }

    setText(title, subtitle) {
        this._title.text = title;
        this._subtitle.text = subtitle ?? '';
        this._subtitle.visible = Boolean(subtitle);
    }
});

const AutoShutdownIndicator = GObject.registerClass(
class AutoShutdownIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.5, _('Auto Shutdown'));

        this._extension = extension;
        this._settings = extension.getSettings();
        this._interfaceSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._logind = new LoginManager();
        this._gicon = Gio.FileIcon.new(
            Gio.File.new_for_path(`${extension.path}/icons/auto-shutdown-symbolic.svg`));

        this._deadline = 0;
        this._type = 'poweroff';
        this._generation = 0;
        this._firedWarnings = new Set();
        this._tickId = 0;
        this._dialog = null;
        this._source = null;
        this._warning = null;

        const box = new St.BoxLayout({style_class: 'panel-status-menu-box'});
        box.add_child(new St.Icon({gicon: this._gicon, style_class: 'system-status-icon'}));
        this._countdown = new St.Label({
            style_class: 'auto-shutdown-countdown',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        box.add_child(this._countdown);
        this.add_child(box);

        this._buildMenu();

        this._settings.connectObject(
            'changed::presets', () => this._rebuildPresets(),
            'changed::show-countdown', () => this._sync(),
            'changed::postpone-minutes', () => this._sync(),
            this);
        this._interfaceSettings.connectObject('changed::clock-format', () => this._sync(), this);
        this.menu.connectObject('open-state-changed', (_menu, open) => {
            if (open)
                this._refresh();
        }, this);

        this._logind.watch(() => this._refresh());
        this._pollId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, POLL_INTERVAL_SECONDS, () => {
            this._refresh();
            return GLib.SOURCE_CONTINUE;
        });

        this._sync();
        this._refresh();
    }

    _buildMenu() {
        this._statusItem = new StatusItem();
        this.menu.addMenuItem(this._statusItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(_('Shut Down In')));

        this._presetSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._presetSection);
        this._rebuildPresets();

        this.menu.addAction(_('Custom Time…'), () => this._openCustomDialog());

        this._activeSection = new PopupMenu.PopupMenuSection();
        this._activeSection.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._postponeItem = this._activeSection.addAction('', () => this._postpone());
        this._activeSection.addAction(_('Cancel Shutdown'), () => this._cancel());
        this.menu.addMenuItem(this._activeSection);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addAction(_('Settings'), () => this._extension.openPreferences());
    }

    _rebuildPresets() {
        this._presetSection.removeAll();

        for (const minutes of cleanMinutes(this._settings.get_value('presets').deepUnpack())) {
            this._presetSection.addAction(formatDuration(minutes),
                () => this._schedule(GLib.get_real_time() + minutes * 60 * GLib.USEC_PER_SEC));
        }
    }

    _openCustomDialog() {
        if (this._dialog)
            return;

        this.menu.close();
        this._dialog = new CustomTimeDialog({
            initialMinutes: this._settings.get_int('last-custom-minutes'),
            use12h: this._use12h(),
            onSchedule: (deadline, delayMinutes) => {
                if (delayMinutes !== null)
                    this._settings.set_int('last-custom-minutes', delayMinutes);
                this._schedule(deadline);
            },
        });
        this._dialog.connect('destroy', () => {
            this._dialog = null;
        });
        this._dialog.open();
    }

    async _schedule(deadline, type = 'poweroff') {
        const generation = ++this._generation;

        try {
            await this._logind.schedule(deadline, type, this._settings.get_boolean('dry-run'));
            if (generation === this._generation)
                this._setDeadline(Math.round(deadline), type);
        } catch (error) {
            this._reportError(_('Could not schedule the shutdown'), error);
        }
    }

    _postpone() {
        const now = GLib.get_real_time();
        const step = this._settings.get_int('postpone-minutes') * 60 * GLib.USEC_PER_SEC;
        this._schedule(Math.max(this._deadline, now) + step, this._type);
    }

    async _cancel() {
        const generation = ++this._generation;

        try {
            await this._logind.cancel();
            if (generation === this._generation)
                this._setDeadline(0);
        } catch (error) {
            this._reportError(_('Could not cancel the shutdown'), error);
        }
    }

    async _refresh() {
        const generation = this._generation;

        try {
            const scheduled = await this._logind.getScheduledShutdown();
            // Ignore results that raced with our own schedule/cancel call.
            if (generation === this._generation)
                this._setDeadline(scheduled?.deadline ?? 0, scheduled?.type ?? 'poweroff');
        } catch (error) {
            if (!isCancelledError(error))
                console.warn(`Auto Shutdown: could not read the logind schedule: ${error.message}`);
        }
    }

    _reportError(title, error) {
        if (isCancelledError(error))
            return;

        console.error(error);
        Main.notifyError(title, error.message);
    }

    _setDeadline(deadline, type = 'poweroff') {
        if (deadline === this._deadline && type === this._type)
            return;

        this._deadline = deadline;
        this._type = type;
        this._firedWarnings.clear();
        this._warning?.destroy();

        // Warnings whose time has already passed (e.g. a 5 min warning for a
        // 3 min timer) must not fire right away.
        const remaining = this._remainingSeconds();
        for (const minutes of this._warningMinutes()) {
            if (remaining <= minutes * 60)
                this._firedWarnings.add(minutes);
        }

        if (deadline && !this._tickId) {
            this._tickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => this._tick());
        } else if (!deadline && this._tickId) {
            GLib.source_remove(this._tickId);
            this._tickId = 0;
        }

        this._sync();
    }

    _tick() {
        if (!this._deadline) {
            this._tickId = 0;
            return GLib.SOURCE_REMOVE;
        }

        this._checkWarnings();
        this._sync();
        return GLib.SOURCE_CONTINUE;
    }

    _checkWarnings() {
        if (!this._settings.get_boolean('warnings-enabled'))
            return;

        const remaining = this._remainingSeconds();
        const due = this._warningMinutes()
            .filter(minutes => !this._firedWarnings.has(minutes) && remaining <= minutes * 60);

        if (due.length === 0 || remaining <= 0)
            return;

        // After a suspend several thresholds may pass at once; warn only once.
        due.forEach(minutes => this._firedWarnings.add(minutes));
        this._showWarning(remaining);
    }

    _showWarning(remaining) {
        if (!this._source) {
            this._source = new MessageTray.Source({title: _('Auto Shutdown'), icon: this._gicon});
            this._source.connect('destroy', () => {
                this._source = null;
            });
            Main.messageTray.add(this._source);
        }

        this._warning?.destroy();

        const notification = new MessageTray.Notification({
            source: this._source,
            title: _('Shutting down in %s').replace('%s', formatRemaining(remaining)),
            body: _('The computer will power off %s. Save your work.')
                .replace('%s', formatDeadline(this._deadline, this._use12h())),
            urgency: remaining <= 60 ? MessageTray.Urgency.CRITICAL : MessageTray.Urgency.HIGH,
            gicon: this._gicon,
        });
        notification.addAction(this._postponeLabel(), () => this._postpone());
        notification.addAction(_('Cancel Shutdown'), () => this._cancel());
        notification.connect('destroy', () => {
            if (this._warning === notification)
                this._warning = null;
        });

        this._warning = notification;
        this._source.addNotification(notification);
    }

    _sync() {
        const active = this._deadline > 0;
        const remaining = this._remainingSeconds();

        if (active) {
            this._statusItem.setText(
                this._statusTitle().replace('%s', formatDeadline(this._deadline, this._use12h())),
                remaining > 0
                    ? _('%s remaining').replace('%s', formatRemaining(remaining))
                    : _('Shutting down…'));
        } else {
            this._statusItem.setText(_('No shutdown scheduled'), null);
        }

        this._countdown.text = formatCountdown(remaining);
        this._countdown.visible = active && this._settings.get_boolean('show-countdown');
        this._activeSection.actor.visible = active;
        this._postponeItem.label.text = this._postponeLabel();

        if (active)
            this.add_style_class_name('auto-shutdown-active');
        else
            this.remove_style_class_name('auto-shutdown-active');
    }

    _statusTitle() {
        // Also reflect schedules made elsewhere, e.g. `shutdown -r +5`.
        switch (this._type) {
        case 'poweroff':
            return _('Shutdown %s');
        case 'reboot':
        case 'kexec':
        case 'soft-reboot':
            return _('Restart %s');
        default:
            return _('Halt %s');
        }
    }

    _postponeLabel() {
        return _('Postpone by %s').replace('%s', formatDuration(this._settings.get_int('postpone-minutes')));
    }

    _remainingSeconds() {
        if (!this._deadline)
            return 0;

        return (this._deadline - GLib.get_real_time()) / GLib.USEC_PER_SEC;
    }

    _warningMinutes() {
        return cleanMinutes(this._settings.get_value('warning-minutes').deepUnpack());
    }

    _use12h() {
        return this._interfaceSettings.get_string('clock-format') === '12h';
    }

    destroy() {
        // Disabling the extension (e.g. on screen lock) must not cancel the
        // shutdown; logind keeps the timer.
        if (this._tickId)
            GLib.source_remove(this._tickId);
        if (this._pollId)
            GLib.source_remove(this._pollId);
        this._tickId = 0;
        this._pollId = 0;

        this._logind.destroy();
        this._settings.disconnectObject(this);
        this._interfaceSettings.disconnectObject(this);
        this._dialog?.destroy();
        this._source?.destroy();

        super.destroy();
    }
});

export default class AutoShutdownExtension extends Extension {
    enable() {
        this._indicator = new AutoShutdownIndicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
