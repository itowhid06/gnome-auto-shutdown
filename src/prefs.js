import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const MAX_DELAY_MINUTES = 99 * 60 + 59;

function parseMinutes(text) {
    const values = text.split(/[\s,;]+/)
        .filter(part => part !== '')
        .map(part => Number(part));

    if (values.some(v => !Number.isInteger(v) || v < 1 || v > MAX_DELAY_MINUTES))
        return null;

    return [...new Set(values)];
}

export default class AutoShutdownPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window._settings = settings;

        const page = new Adw.PreferencesPage({
            title: _('General'),
            icon_name: 'preferences-system-symbolic',
        });
        window.add(page);

        const menuGroup = new Adw.PreferencesGroup({
            title: _('Top Bar'),
            description: _('A shutdown scheduled here is kept by the system and survives screen locking and GNOME Shell restarts.'),
        });
        page.add(menuGroup);

        const countdownRow = new Adw.SwitchRow({
            title: _('Show Countdown'),
            subtitle: _('Display the remaining time next to the icon'),
        });
        settings.bind('show-countdown', countdownRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        menuGroup.add(countdownRow);

        menuGroup.add(this._minutesListRow(settings, 'presets', {
            title: _('Quick Options (minutes, comma-separated)'),
            sortDescending: false,
        }));

        const postponeRow = new Adw.SpinRow({
            title: _('Postpone Step'),
            subtitle: _('Minutes added by “Postpone”'),
            adjustment: new Gtk.Adjustment({lower: 1, upper: 1440, step_increment: 5, page_increment: 30}),
        });
        settings.bind('postpone-minutes', postponeRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        menuGroup.add(postponeRow);

        const warningGroup = new Adw.PreferencesGroup({title: _('Warnings')});
        page.add(warningGroup);

        const warningsRow = new Adw.SwitchRow({
            title: _('Warn Before Shutdown'),
            subtitle: _('Show a notification with Postpone and Cancel buttons'),
        });
        settings.bind('warnings-enabled', warningsRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        warningGroup.add(warningsRow);

        const warningMinutesRow = this._minutesListRow(settings, 'warning-minutes', {
            title: _('Warn at (minutes before, comma-separated)'),
            sortDescending: true,
        });
        settings.bind('warnings-enabled', warningMinutesRow, 'sensitive', Gio.SettingsBindFlags.GET);
        warningGroup.add(warningMinutesRow);

        const advancedGroup = new Adw.PreferencesGroup({title: _('Advanced')});
        page.add(advancedGroup);

        const dryRunRow = new Adw.SwitchRow({
            title: _('Dry Run'),
            subtitle: _('For testing: the timer runs normally but the computer does not power off'),
        });
        settings.bind('dry-run', dryRunRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        advancedGroup.add(dryRunRow);
    }

    _minutesListRow(settings, key, {title, sortDescending}) {
        const row = new Adw.EntryRow({title, show_apply_button: true});
        const load = () => {
            row.text = settings.get_value(key).deepUnpack().join(', ');
            row.remove_css_class('error');
        };

        row.connect('apply', () => {
            const values = parseMinutes(row.text);
            if (!values || values.length === 0) {
                row.add_css_class('error');
                return;
            }

            values.sort((a, b) => sortDescending ? b - a : a - b);
            settings.set_value(key, new GLib.Variant('ai', values));
            load();
        });
        row.connect('changed', () => row.remove_css_class('error'));
        const changedId = settings.connect(`changed::${key}`, load);
        row.connect('destroy', () => settings.disconnect(changedId));
        load();

        return row;
    }
}
